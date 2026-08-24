// =====================================================================
// RITTUS ONE — Ponte de dados Supabase (supabase-bridge.js)
// ---------------------------------------------------------------------
// Substitui o localStorage por Supabase SEM precisar reescrever as
// funções do app.html. Estratégia:
//
//   1. Ao carregar a página, autentica o usuário e baixa TODOS os dados
//      da organização dele para dentro de `window.__cache` (um objeto em
//      memória, no MESMO formato que cada chave tinha no localStorage).
//   2. Expõe duas funções globais, `_dbGet(chave, padrao)` e
//      `_dbSet(chave, valor)`, que o app.html usa no lugar de
//      `localStorage.getItem/setItem`.
//        - `_dbGet` é SÍNCRONA — lê direto do cache em memória (por isso
//          o carregamento inicial precisa terminar antes de qualquer
//          tela real ser usada; ver `RITTUS_READY` abaixo).
//        - `_dbSet` atualiza o cache na hora (então a tela nunca trava)
//          e envia a mudança pro Supabase em segundo plano (diff por
//          id_local: insere o que é novo, atualiza o que mudou, apaga o
//          que sumiu do array).
//   3. `window.RITTUS_READY` é uma Promise que resolve quando o cache
//      termina de carregar. As 3 telas que hoje populam algo direto no
//      DOMContentLoaded (ver comentário no app.html) re-rodam sozinhas
//      quando essa promise resolve, então não é preciso reordenar nada
//      do app.html original.
//
// Esse arquivo é "classic script" (sem type=module) de propósito: o
// app.html grande também é classic script e depende de todas as suas
// ~293 funções ficarem em `window` (para os onclick="..." funcionarem).
// Carregar como módulo quebraria isso.
// =====================================================================

(function () {
  'use strict';

  if (!window.RITTUS_SUPABASE_URL || !window.RITTUS_SUPABASE_ANON_KEY) {
    console.error('[bridge] config.js não carregou SUPABASE_URL/ANON_KEY antes deste arquivo.');
  }
  if (!window.supabase || !window.supabase.createClient) {
    console.error('[bridge] biblioteca @supabase/supabase-js (UMD) não carregou antes deste arquivo.');
  }

  var _sb = window.supabase.createClient(window.RITTUS_SUPABASE_URL, window.RITTUS_SUPABASE_ANON_KEY);
  window.supabaseClient = _sb;

  window.__cache = {};
  window.__orgId = null;
  window.__userId = null;
  window.__cacheReady = false;

  var BUCKET_EVID = 'evidencias';
  var BUCKET_RID = 'rittus-id';

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------
  function log() { console.log.apply(console, ['[bridge]'].concat(Array.prototype.slice.call(arguments))); }
  function warn() { console.warn.apply(console, ['[bridge]'].concat(Array.prototype.slice.call(arguments))); }

  function toast(msg, tipo) {
    try {
      if (typeof window._mostrarToast === 'function') { window._mostrarToast(msg, tipo); return; }
    } catch (e) {}
    // Sem o toast do app disponível ainda (ex.: erro bem no início do carregamento) —
    // mostra um aviso fixo na tela em vez de só no console, que ninguém vê.
    try {
      var div = document.createElement('div');
      div.textContent = msg;
      div.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:999999;background:#B00020;color:#fff;padding:10px 14px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3)';
      document.body && document.body.appendChild(div);
      setTimeout(function () { div.remove(); }, 6000);
    } catch (e) { console.log('[toast]', msg); }
  }

  // Avisos de falha de SINCRONIZAÇÃO precisam ser VISÍVEIS — antes esse tipo de
  // erro só ia pro console (ninguém vê no celular), e o dado parecia "salvo"
  // porque a tela usa o cache local otimista mesmo quando o envio à nuvem falha.
  // Isso foi identificado como a causa mais provável de "salva no meu aparelho
  // mas não aparece no outro": a gravação no Supabase falhava (RLS, sessão
  // expirada, sem internet) e o app não avisava ninguém.
  var _ultimoAvisoVisivel = 0;
  function avisar(msg) {
    warn(msg);
    var agora = Date.now();
    if (agora - _ultimoAvisoVisivel > 4000) {
      _ultimoAvisoVisivel = agora;
      toast('⚠️ Não sincronizou com a nuvem: ' + msg + ' — os dados ficaram só neste aparelho por enquanto.', 'erro');
    }
  }

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var mimeMatch = /data:(.*?);base64/.exec(parts[0]);
    var mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  // Converte um dataURL (base64) em arquivo no Storage e devolve a URL pública.
  // Se `valor` já não for um dataURL (é uma URL comum, vazio, etc.), devolve como está.
  async function uploadSeDataUrl(bucket, valor, pathHint) {
    if (!valor || typeof valor !== 'string' || valor.indexOf('data:') !== 0) return valor || null;
    try {
      var blob = dataUrlToBlob(valor);
      var ext = (blob.type.split('/')[1] || 'bin').split('+')[0];
      var path = (window.__orgId || 'sem-org') + '/' + pathHint + '-' + Date.now() + '-' + Math.floor(Math.random() * 9999) + '.' + ext;
      var up = await _sb.storage.from(bucket).upload(path, blob, { upsert: true, contentType: blob.type });
      if (up.error) { warn('upload falhou, mantendo base64 local:', up.error.message); return valor; }
      var pub = _sb.storage.from(bucket).getPublicUrl(path);
      return pub.data.publicUrl;
    } catch (e) { warn('upload exception, mantendo base64 local:', e); return valor; }
  }

  async function uploadArrayDataUrls(bucket, arr, pathHint) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(await uploadSeDataUrl(bucket, arr[i], pathHint + '-' + i));
    return out;
  }

  function achaIdPorNome(lista, nome) {
    if (!nome) return null;
    var alvo = String(nome).trim().toLowerCase();
    var achou = (lista || []).find(function (x) {
      return ((x.nome || x.razao_social || '')).trim().toLowerCase() === alvo;
    });
    return achou ? achou.id : null;
  }

  // ------------------------------------------------------------------
  // Motor genérico de sincronização: array local (com um campo "chave
  // local", ex.: id ou num) <-> tabela Supabase (com id_local + coluna extra
  // pra qualquer campo não mapeado explicitamente).
  // ------------------------------------------------------------------
  function novoMotorArray(opts) {
    // opts: {table, localKeyField, toRow(item) -> async row, fromRow(row) -> item}
    return {
      async carregar() {
        var { data, error } = await _sb.from(opts.table).select('*').eq('organizacao_id', window.__orgId).order('criado_em', { ascending: false });
        if (error) { avisar('não consegui carregar ' + opts.table + ' (' + error.message + ')'); return []; }
        return (data || []).map(opts.fromRow);
      },
      async sincronizar(novoArray, cacheAnterior) {
        var antigos = {};
        (cacheAnterior || []).forEach(function (it) { antigos[String(it[opts.localKeyField])] = it; });
        var vistos = {};
        for (var i = 0; i < novoArray.length; i++) {
          var item = novoArray[i];
          var chave = String(item[opts.localKeyField] || '');
          if (!chave) continue; // sem chave local não dá pra rastrear com segurança — ignora
          vistos[chave] = true;
          var antigo = antigos[chave];
          if (antigo && JSON.stringify(antigo) === JSON.stringify(item)) continue; // nada mudou
          try {
            var row = await opts.toRow(item);
            row.organizacao_id = window.__orgId;
            row.id_local = chave;
            var { error } = await _sb.from(opts.table).upsert(row, { onConflict: 'organizacao_id,id_local' });
            if (error) avisar('falha ao salvar em ' + opts.table + ' (' + error.message + ')');
          } catch (e) { avisar('erro ao preparar dados de ' + opts.table + ' (' + (e && e.message || e) + ')'); }
        }
        // remove o que sumiu do array local
        for (var k in antigos) {
          if (!vistos[k]) {
            try {
              var { error: delErr } = await _sb.from(opts.table).delete().eq('organizacao_id', window.__orgId).eq('id_local', k);
              if (delErr) avisar('falha ao remover item de ' + opts.table + ' (' + delErr.message + ')');
            } catch (e) { avisar('erro ao remover item de ' + opts.table + ' (' + (e && e.message || e) + ')'); }
          }
        }
      },
    };
  }

  // ------------------------------------------------------------------
  // Adaptadores por chave de localStorage
  // ------------------------------------------------------------------
  var motores = {};

  motores['sst_auditorias'] = novoMotorArray({
    table: 'auditorias',
    localKeyField: 'id',
    async toRow(it) {
      var empresas = window.__cache.__empresasResolvidas || [];
      var unidades = window.__cache.__unidadesResolvidas || [];
      return {
        numero: it.id, tipo_auditoria: it.tipoAud, data: it.data || null,
        empresa_id: achaIdPorNome(empresas, it.empresa), empresa_nome: it.empresa,
        unidade_id: achaIdPorNome(unidades, it.unidade), unidade_nome: it.unidade,
        setor: it.setor, auditor: it.auditor, escopo: it.escopo, objetivo: it.objetivo,
        resultado: it.resultado, conclusao: it.conclusao, itens: it.state || {},
        extra: { timestamp: it.timestamp, tipo: it.tipo },
      };
    },
    fromRow(r) {
      return {
        id: r.id_local, tipo: 'auditoria', tipoAud: r.tipo_auditoria, data: r.data,
        empresa: r.empresa_nome, unidade: r.unidade_nome, setor: r.setor, auditor: r.auditor,
        escopo: r.escopo, objetivo: r.objetivo, resultado: r.resultado, conclusao: r.conclusao,
        state: r.itens || {}, timestamp: (r.extra && r.extra.timestamp) || r.criado_em,
      };
    },
  });

  motores['sst_pts'] = novoMotorArray({
    table: 'pts',
    localKeyField: 'id',
    async toRow(it) {
      var unidades = window.__cache.__unidadesResolvidas || [];
      return {
        numero: it.id, tipo_pt: it.tipoPT, data: it.data || null, local_execucao: it.local,
        unidade_id: achaIdPorNome(unidades, it.unidade), unidade_nome: it.unidade,
        descricao: it.descricao,
        extra: { timestamp: it.timestamp, tipo: it.tipo },
      };
    },
    fromRow(r) {
      return {
        id: r.id_local, tipo: 'pt', tipoPT: r.tipo_pt, data: r.data, local: r.local_execucao,
        unidade: r.unidade_nome, descricao: r.descricao,
        timestamp: (r.extra && r.extra.timestamp) || r.criado_em,
      };
    },
  });

  motores['sst_aprs'] = novoMotorArray({
    table: 'aprs',
    localKeyField: 'id',
    async toRow(it) {
      var unidades = window.__cache.__unidadesResolvidas || [];
      return {
        numero: it.id, data: it.data || null, hora: it.hora || null,
        unidade_id: achaIdPorNome(unidades, it.unidade), unidade_nome: it.unidade,
        setor: it.setor, responsavel: it.responsavel, descricao: it.descricao,
        extra: { timestamp: it.timestamp, tipo: it.tipo, numEtapas: it.numEtapas },
      };
    },
    fromRow(r) {
      return {
        id: r.id_local, tipo: 'apr', data: r.data, hora: r.hora, unidade: r.unidade_nome,
        setor: r.setor, responsavel: r.responsavel, descricao: r.descricao,
        numEtapas: (r.extra && r.extra.numEtapas) || 0,
        timestamp: (r.extra && r.extra.timestamp) || r.criado_em,
      };
    },
  });

  motores['sst_docs_inspecoes'] = novoMotorArray({
    table: 'docs_inspecoes',
    localKeyField: 'id',
    async toRow(it) {
      var unidades = window.__cache.__unidadesResolvidas || [];
      return {
        numero: it.id, subcategoria: it.subcat, data: it.data || null,
        unidade_id: achaIdPorNome(unidades, it.unidade), unidade_nome: it.unidade,
        responsavel: it.resp, setor: it.setor, geolocalizacao: it.geo, itens: it.itens || {},
        extra: { timestamp: it.timestamp, tipo: it.tipo },
      };
    },
    fromRow(r) {
      return {
        id: r.id_local, tipo: 'docs', subcat: r.subcategoria, data: r.data,
        unidade: r.unidade_nome, resp: r.responsavel, setor: r.setor, geo: r.geolocalizacao,
        itens: r.itens || {}, timestamp: (r.extra && r.extra.timestamp) || r.criado_em,
      };
    },
  });

  motores['ci_equipamentos'] = novoMotorArray({
    table: 'ci_equipamentos',
    localKeyField: 'id',
    async toRow(it) {
      var unidades = window.__cache.__unidadesResolvidas || [];
      var fotos = await uploadArrayDataUrls(BUCKET_EVID, it.fotos || [], 'ci-eq-' + (it.id || 'novo'));
      return {
        codigo: it.id, tipo: it.tipo, status: it.status,
        unidade_id: achaIdPorNome(unidades, it.unidade), unidade_nome: it.unidade,
        setor: it.setor, local_especifico: it.local, fabricante: it.fabricante, modelo: it.modelo,
        serie: it.serie, data_fabricacao: it.dataFab || null, data_instalacao: it.dataInst || null,
        ultima_inspecao: it.ultInsp || null, proxima_inspecao: it.proxInsp || null,
        ultima_manutencao: it.ultManut || null, proxima_manutencao: it.proxManut || null,
        observacoes: it.obs, fotos: fotos, extra: { timestamp: it.timestamp },
      };
    },
    fromRow(r) {
      return {
        id: r.id_local, tipo: r.tipo, status: r.status, unidade: r.unidade_nome, setor: r.setor,
        local: r.local_especifico, fabricante: r.fabricante, modelo: r.modelo, serie: r.serie,
        dataFab: r.data_fabricacao, dataInst: r.data_instalacao, ultInsp: r.ultima_inspecao,
        proxInsp: r.proxima_inspecao, ultManut: r.ultima_manutencao, proxManut: r.proxima_manutencao,
        obs: r.observacoes, fotos: r.fotos || [], timestamp: (r.extra && r.extra.timestamp) || r.criado_em,
      };
    },
  });

  motores['ci_inspecoes'] = novoMotorArray({
    table: 'ci_inspecoes',
    localKeyField: 'id',
    async toRow(it) {
      var fotos = await uploadArrayDataUrls(BUCKET_EVID, it.fotos || [], 'ci-insp-' + (it.id || 'novo'));
      return { numero: it.id, modulo: it.modulo || 'geral', fotos: fotos, extra: { timestamp: it.timestamp } };
    },
    fromRow(r) {
      return { id: r.id_local, modulo: r.modulo, fotos: r.fotos || [], timestamp: (r.extra && r.extra.timestamp) || r.criado_em };
    },
  });

  motores['rittus_id_empresas'] = novoMotorArray({
    table: 'rittus_id_empresas',
    localKeyField: 'id',
    async toRow(it) { return { nome: it.nome, cnpj: it.cnpj, unidades: it.unidades || [] }; },
    fromRow(r) { return { id: r.id_local, nome: r.nome, cnpj: r.cnpj, unidades: r.unidades || [] }; },
  });

  motores['rittus_id_colaboradores'] = novoMotorArray({
    table: 'rittus_id_colaboradores',
    localKeyField: 'id',
    async toRow(it) {
      var foto = await uploadSeDataUrl(BUCKET_RID, it.foto, 'colab-' + (it.id || 'novo') + '-foto');
      // sub-arrays: cada item pode ter um campo "arquivo" em dataURL — sobe pro storage também
      async function subir(lista, prefixo) {
        var out = [];
        for (var i = 0; i < (lista || []).length; i++) {
          var sub = Object.assign({}, lista[i]);
          if (sub.arquivo) sub.arquivo = await uploadSeDataUrl(BUCKET_RID, sub.arquivo, prefixo + '-' + i);
          out.push(sub);
        }
        return out;
      }
      var idBase = it.id || 'novo';
      return {
        qr_id: it.qrId, nome: it.nome, cpf: it.cpf, rg: it.rg, matricula: it.matricula,
        status_admissao: it.status, empresa_nome: it.empresa, unidade_nome: it.unidade,
        centro_custo: it.centroCusto, funcao: it.funcao, cargo: it.cargo, gestor: it.gestor,
        data_admissao: it.dataAdmissao || null, tipo_sanguineo: it.tipoSanguineo, telefone: it.telefone,
        email: it.email, contato_emergencia: it.contatoEmergencia, observacoes: it.observacoes,
        foto_url: foto,
        asos: await subir(it.asos, 'colab-' + idBase + '-aso'),
        treinamentos: await subir(it.treinamentos, 'colab-' + idBase + '-trein'),
        ordens_servico: await subir(it.ordensServico, 'colab-' + idBase + '-os'),
        epis: await subir(it.epis, 'colab-' + idBase + '-epi'),
        integracoes: await subir(it.integracoes, 'colab-' + idBase + '-integ'),
        exames: await subir(it.exames, 'colab-' + idBase + '-exame'),
        vacinas: await subir(it.vacinas, 'colab-' + idBase + '-vacina'),
        cats: await subir(it.cats, 'colab-' + idBase + '-cat'),
        documentos: await subir((it.documentos || []).map(function (d) { return Object.assign({ arquivo: d.arquivo }, d); }), 'colab-' + idBase + '-doc'),
        extra: { dataCriacao: it.dataCriacao, dataAtualizacao: it.dataAtualizacao },
      };
    },
    fromRow(r) {
      return {
        id: r.id_local, qrId: r.qr_id, nome: r.nome, cpf: r.cpf, rg: r.rg, matricula: r.matricula,
        status: r.status_admissao, empresa: r.empresa_nome, unidade: r.unidade_nome,
        centroCusto: r.centro_custo, funcao: r.funcao, cargo: r.cargo, gestor: r.gestor,
        dataAdmissao: r.data_admissao, tipoSanguineo: r.tipo_sanguineo, telefone: r.telefone,
        email: r.email, contatoEmergencia: r.contato_emergencia, observacoes: r.observacoes,
        foto: r.foto_url, asos: r.asos || [], treinamentos: r.treinamentos || [],
        ordensServico: r.ordens_servico || [], epis: r.epis || [], integracoes: r.integracoes || [],
        exames: r.exames || [], vacinas: r.vacinas || [], cats: r.cats || [], documentos: r.documentos || [],
        dataCriacao: (r.extra && r.extra.dataCriacao) || r.criado_em,
        dataAtualizacao: (r.extra && r.extra.dataAtualizacao) || r.atualizado_em,
      };
    },
  });

  motores['sst_planos'] = novoMotorArray({
    table: 'planos_acao',
    localKeyField: 'num',
    async toRow(it) {
      var empresas = window.__cache.__empresasResolvidas || [];
      var unidades = window.__cache.__unidadesResolvidas || [];
      var fotos = await uploadArrayDataUrls(BUCKET_EVID, it.fotos || [], 'pa-' + (it.num || 'novo'));
      return {
        numero_visivel: it.num, origem: it.origem, empresa_id: achaIdPorNome(empresas, it.empresa),
        empresa_nome: it.empresa, unidade_id: achaIdPorNome(unidades, it.unidade), unidade_nome: it.unidade,
        area: it.area, nao_conformidade: it.desvio || '(sem descrição)', evidencia: it.evidencia,
        causa_raiz: it.causa, acao_corretiva: it.acaoCorretiva, acao_preventiva: it.acaoPreventiva,
        responsavel: it.responsavel, prazo: it.prazo || null,
        criticidade: (it.criticidade || 'Media').toLowerCase().replace('í', 'i').replace('é', 'e'),
        status: mapStatusPA(it.status), rotulo_status: it.stLabel, comentarios: it.comentarios,
        fotos: fotos.map(function (u) { return { url: u }; }), historico: it.historico || [],
        extra: { dataCriacao: it.dataCriacao, dataAtualizacao: it.dataAtualizacao },
      };
    },
    fromRow(r) {
      return {
        num: r.id_local, origem: r.origem, empresa: r.empresa_nome, unidade: r.unidade_nome,
        area: r.area, desvio: r.nao_conformidade, evidencia: r.evidencia, causa: r.causa_raiz,
        acaoCorretiva: r.acao_corretiva, acaoPreventiva: r.acao_preventiva, responsavel: r.responsavel,
        prazo: r.prazo, criticidade: capitaliza(r.criticidade), status: r.status, stLabel: r.rotulo_status,
        comentarios: r.comentarios, fotos: (r.fotos || []).map(function (f) { return f.url; }),
        historico: r.historico || [], dataCriacao: (r.extra && r.extra.dataCriacao) || r.criado_em,
        dataAtualizacao: (r.extra && r.extra.dataAtualizacao) || r.atualizado_em,
      };
    },
  });
  function mapStatusPA(s) {
    var m = { aberta: 'aberta', andamento: 'andamento', validacao: 'validacao', concluida: 'concluida', cancelada: 'cancelada', vencida: 'vencida' };
    return m[s] || 'aberta';
  }
  function capitaliza(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  // sst_inspecoes: shape variável (fluxo linear x multi-módulo) — ver README.
  // Guardamos os campos conhecidos nas colunas certas e TUDO o mais em `extra`,
  // então nenhum campo é perdido mesmo quando o shape muda de novo no futuro.
  motores['sst_inspecoes'] = novoMotorArray({
    table: 'inspecoes',
    localKeyField: 'id',
    async toRow(it) {
      var empresas = window.__cache.__empresasResolvidas || [];
      var unidades = window.__cache.__unidadesResolvidas || [];
      var sigInsp = await uploadSeDataUrl(BUCKET_EVID, it.sigInspetor, 'insp-' + (it.id || 'novo') + '-sig-insp');
      var sigResp = await uploadSeDataUrl(BUCKET_EVID, it.sigResponsavel, 'insp-' + (it.id || 'novo') + '-sig-resp');
      var conhecidos = ['id', 'timestamp', 'empresa', 'unidade', 'cnpj', 'setor', 'local', 'data', 'hora',
        'tipoInspecao', 'inspetor', 'emailInspetor', 'responsavel', 'emailResponsavel', 'numColab', 'atividade',
        'tipoAcompanhante', 'acompanhante', 'riscos', 'checklist', 'planoAcao', 'avaliacaoGeral', 'obsFinal',
        'totalItens', 'conformes', 'naoConformes', 'naoAplicaveis', 'pctConformidade', 'sigInspetor',
        'sigResponsavel', 'nomeInspetor', 'nomeResponsavel', 'dataAssinatura', '_synced', 'modalidades',
        'modulos', 'nrsSelecionadas', 'tipo', 'status'];
      var extra = {};
      Object.keys(it).forEach(function (k) { if (conhecidos.indexOf(k) === -1) extra[k] = it[k]; });
      var pct = parseInt(String(it.pctConformidade || '0')) || 0;
      return {
        numero: null, // deixa o trigger numera_inspecao() gerar o INS-AAAA-NNNN oficial
        fluxo: it.tipo === 'multi' ? 'multi' : 'linear',
        data: it.data || null, hora: it.hora || null,
        empresa_id: achaIdPorNome(empresas, it.empresa), empresa_nome: it.empresa, cnpj: it.cnpj,
        unidade_id: achaIdPorNome(unidades, it.unidade), unidade_nome: it.unidade,
        area: it.setor, local_especifico: it.local,
        inspetor: it.inspetor, email_inspetor: it.emailInspetor,
        responsavel: it.responsavel, email_responsavel: it.emailResponsavel,
        acompanhante: it.acompanhante, tipo_acompanhante: it.tipoAcompanhante,
        num_colaboradores: parseInt(it.numColab) || null, atividade_no_momento: it.atividade,
        nrs: it.nrsSelecionadas ? String(it.nrsSelecionadas).split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        modalidades: it.modalidades || [], modulos: it.modulos || [],
        riscos: it.riscos || {}, total_itens: it.totalItens || 0, conformes: it.conformes || 0,
        nao_conformes: it.naoConformes || 0, nao_aplicaveis: it.naoAplicaveis || 0, conformidade: pct,
        avaliacao_geral: it.avaliacaoGeral, observacoes: it.obsFinal,
        status: it.status === 'Concluída' ? 'finalizada' : (it.status || 'finalizada'),
        assinatura_inspetor_url: sigInsp, nome_inspetor_assinatura: it.nomeInspetor,
        assinatura_responsavel_url: sigResp, nome_responsavel_assinatura: it.nomeResponsavel,
        data_assinatura: it.dataAssinatura || null,
        sincronizado: !!it._synced, sincronizado_em: it._synced ? nowIso() : null,
        finalizado_em: nowIso(), extra: extra,
      };
    },
    fromRow(r) {
      var base = Object.assign({}, r.extra || {});
      base.id = r.id_local; base.numero = r.numero; base.timestamp = r.criado_em;
      base.empresa = r.empresa_nome; base.unidade = r.unidade_nome; base.cnpj = r.cnpj;
      base.setor = r.area; base.local = r.local_especifico; base.data = r.data; base.hora = r.hora;
      base.inspetor = r.inspetor; base.emailInspetor = r.email_inspetor; base.responsavel = r.responsavel;
      base.emailResponsavel = r.email_responsavel; base.numColab = r.num_colaboradores; base.atividade = r.atividade_no_momento;
      base.tipoAcompanhante = r.tipo_acompanhante; base.acompanhante = r.acompanhante;
      base.riscos = r.riscos || {}; base.totalItens = r.total_itens; base.conformes = r.conformes;
      base.naoConformes = r.nao_conformes; base.naoAplicaveis = r.nao_aplicaveis;
      base.pctConformidade = (r.conformidade || 0) + '%'; base.avaliacaoGeral = r.avaliacao_geral;
      base.obsFinal = r.observacoes; base.sigInspetor = r.assinatura_inspetor_url;
      base.sigResponsavel = r.assinatura_responsavel_url; base.nomeInspetor = r.nome_inspetor_assinatura;
      base.nomeResponsavel = r.nome_responsavel_assinatura; base.dataAssinatura = r.data_assinatura;
      base._synced = r.sincronizado; base.modalidades = r.modalidades || []; base.modulos = r.modulos || [];
      base.nrsSelecionadas = (r.nrs || []).join(', '); base.tipo = r.fluxo === 'multi' ? 'multi' : 'linear';
      base.status = r.status;
      return base;
    },
  });

  motores['rittus_doc_modelos'] = {
    async carregar() {
      var { data, error } = await _sb.from('doc_modelos').select('*').eq('organizacao_id', window.__orgId);
      if (error) { warn('carregar doc_modelos', error.message); return {}; }
      var out = {};
      (data || []).forEach(function (r) { out[r.nome] = r.itens || []; });
      return out;
    },
    async sincronizar(novoObj) {
      for (var nome in novoObj) {
        try {
          await _sb.from('doc_modelos').upsert(
            { organizacao_id: window.__orgId, nome: nome, itens: novoObj[nome] },
            { onConflict: 'organizacao_id,nome' }
          );
        } catch (e) { warn('doc_modelos upsert', nome, e); }
      }
    },
  };

  // ------------------------------------------------------------------
  // Chaves "singleton" — mapeiam pra colunas da tabela config_geral
  // (rittus_id_config, rittus_id_soc_config, rittus_id_url_producao, sst_script_url)
  // ------------------------------------------------------------------
  async function carregarConfigGeral() {
    var { data, error } = await _sb.from('config_geral').select('*').eq('organizacao_id', window.__orgId).maybeSingle();
    if (error) { warn('carregar config_geral', error.message); return null; }
    return data;
  }
  async function persistirConfigGeral(campos) {
    var row = Object.assign({ organizacao_id: window.__orgId }, campos);
    var { error } = await _sb.from('config_geral').upsert(row, { onConflict: 'organizacao_id' });
    if (error) warn('config_geral upsert', error.message);
  }

  // ------------------------------------------------------------------
  // sst_calc_ultima -> calc_financeiro_historico (histórico real; sempre INSERT)
  // ------------------------------------------------------------------
  async function inserirCalculoFinanceiro(obj) {
    var row = {
      organizacao_id: window.__orgId, num_empregados: obj.nEmp, rat: obj.rat, fap: obj.fap,
      multas_totais: obj.multasTotais, total_geral: obj.totalGeral, score_legal: obj.score,
      extra: obj,
    };
    var { error } = await _sb.from('calc_financeiro_historico').insert(row);
    if (error) warn('calc_financeiro_historico insert', error.message);
  }

  // ------------------------------------------------------------------
  // sst_unidades_extras -> tabela `unidades` | sst_riscos_extras -> `riscos_customizados`
  // ------------------------------------------------------------------
  async function persistirUnidadeExtra(u) {
    var row = { organizacao_id: window.__orgId, nome: u.nome, cnpj: u.cnpj || null, empresa_nome: null };
    var { error } = await _sb.from('unidades').insert(row);
    if (error) warn('unidades insert (extra)', error.message);
  }
  async function persistirRiscoExtra(categoria, texto) {
    var { error } = await _sb.from('riscos_customizados').insert({ organizacao_id: window.__orgId, categoria: categoria, texto: texto });
    if (error) warn('riscos_customizados insert', error.message);
  }

  // ------------------------------------------------------------------
  // API pública usada pelo app.html: _dbGet / _dbSet
  // ------------------------------------------------------------------
  var SINGLETON_KEYS = ['rittus_id_config', 'rittus_id_soc_config', 'rittus_id_url_producao', 'sst_script_url'];

  window._dbGet = function (chave, padrao) {
    if (chave in window.__cache) return window.__cache[chave];
    return padrao;
  };

  window._dbSet = function (chave, valor) {
    var anterior = window.__cache[chave];
    window.__cache[chave] = valor;

    if (chave === 'sst_calc_ultima') {
      inserirCalculoFinanceiro(valor).catch(function (e) { warn(e); });
      return;
    }
    if (chave === 'sst_unidades_extras') {
      // valor é o array COMPLETO; só persiste o item novo (diff simples por tamanho)
      var novos = (valor || []).slice((anterior || []).length);
      novos.forEach(function (u) { persistirUnidadeExtra(u).catch(function (e) { warn(e); }); });
      return;
    }
    if (chave === 'sst_riscos_extras') {
      var antigoObj = anterior || {};
      Object.keys(valor || {}).forEach(function (cat) {
        var novosItens = (valor[cat] || []).slice((antigoObj[cat] || []).length);
        novosItens.forEach(function (texto) { persistirRiscoExtra(cat, texto).catch(function (e) { warn(e); }); });
      });
      return;
    }
    if (SINGLETON_KEYS.indexOf(chave) !== -1) {
      var campos = {};
      if (chave === 'rittus_id_config') {
        var cfg = valor || {};
        campos = { rid_modo: cfg.modo, rid_aso_dias: cfg.asoDias, rid_treino_dias: cfg.treinoDias };
      } else if (chave === 'rittus_id_soc_config') {
        campos = { rid_soc_config: valor || {} };
      } else if (chave === 'rittus_id_url_producao') {
        campos = { rid_url_producao: valor };
      } else if (chave === 'sst_script_url') {
        campos = { script_url_nuvem: valor };
      }
      persistirConfigGeral(campos).catch(function (e) { warn(e); });
      return;
    }

    var motor = motores[chave];
    if (!motor) { avisar('não sei salvar "' + chave + '" na nuvem — ficou só em memória nesta aba.'); return; }
    motor.sincronizar(valor, anterior).catch(function (e) { avisar('falha ao sincronizar ' + chave + ' (' + (e && e.message || e) + ')'); });
  };

  // ------------------------------------------------------------------
  // Carregamento inicial — autentica e baixa tudo para window.__cache
  // ------------------------------------------------------------------
  async function carregarTudo() {
    var { data: sessao } = await _sb.auth.getSession();
    if (!sessao || !sessao.session) {
      if (location.pathname.indexOf('index.html') === -1) location.href = 'index.html';
      return;
    }
    window.__userId = sessao.session.user.id;

    var { data: perfil, error: perfilErr } = await _sb.from('perfis').select('organizacao_id, nome, papel').eq('id', window.__userId).maybeSingle();
    if (perfilErr || !perfil) { avisar('não encontrei seu perfil/organização no banco (' + (perfilErr && perfilErr.message || 'perfil vazio') + '). Você confirmou o e-mail de cadastro?'); return; }
    window.__orgId = perfil.organizacao_id;
    window.__perfil = perfil;

    // DIAGNÓSTICO: mostra em qual organização este login está entrando.
    // Se dois aparelhos deveriam compartilhar dados mas mostram nomes/códigos
    // diferentes aqui, cada um criou sua PRÓPRIA organização (normalmente
    // porque o 2º cadastro foi feito sem preencher "Código da equipe") —
    // essa é a causa mais comum de "salva no meu aparelho, não aparece no outro".
    try {
      var { data: org } = await _sb.from('organizacoes').select('nome, codigo_convite').eq('id', window.__orgId).maybeSingle();
      window.__orgInfo = org || null;
      if (org) {
        log('organização:', org.nome, '| código de equipe:', org.codigo_convite, '| usuário:', perfil.nome, '(' + perfil.papel + ')');
      }
    } catch (e) { warn('não consegui ler organizacoes para diagnóstico', e); }

    var [empresas, unidades, cfg] = await Promise.all([
      _sb.from('empresas').select('id, razao_social as nome, cnpj').eq('organizacao_id', window.__orgId),
      _sb.from('unidades').select('id, nome, cnpj, empresa_id').eq('organizacao_id', window.__orgId),
      carregarConfigGeral(),
    ]);
    window.__cache.__empresasResolvidas = (empresas.data || []);
    window.__cache.__unidadesResolvidas = (unidades.data || []);

    window.__cache['sst_unidades_extras'] = (unidades.data || []).map(function (u) { return { nome: u.nome, cnpj: u.cnpj }; });

    var { data: riscosRows } = await _sb.from('riscos_customizados').select('categoria, texto').eq('organizacao_id', window.__orgId);
    var riscosObj = {};
    (riscosRows || []).forEach(function (r) { (riscosObj[r.categoria] = riscosObj[r.categoria] || []).push(r.texto); });
    window.__cache['sst_riscos_extras'] = riscosObj;

    if (cfg) {
      window.__cache['rittus_id_config'] = { modo: cfg.rid_modo, asoDias: cfg.rid_aso_dias, treinoDias: cfg.rid_treino_dias };
      window.__cache['rittus_id_soc_config'] = cfg.rid_soc_config || {};
      window.__cache['rittus_id_url_producao'] = cfg.rid_url_producao || '';
      window.__cache['sst_script_url'] = cfg.script_url_nuvem || '';
    }

    var chaves = ['sst_inspecoes', 'sst_auditorias', 'sst_pts', 'sst_aprs', 'sst_planos',
      'sst_docs_inspecoes', 'ci_equipamentos', 'ci_inspecoes', 'rittus_id_colaboradores', 'rittus_id_empresas'];
    await Promise.all(chaves.map(function (chave) {
      return motores[chave].carregar().then(function (arr) { window.__cache[chave] = arr; });
    }));
    window.__cache['rittus_doc_modelos'] = await motores['rittus_doc_modelos'].carregar();

    window.__cacheReady = true;
    log('cache carregado:', Object.keys(window.__cache).map(function (k) { return k + '(' + (Array.isArray(window.__cache[k]) ? window.__cache[k].length : 1) + ')'; }).join(', '));
    document.dispatchEvent(new CustomEvent('rittus:cache-pronto'));
  }

  window.RITTUS_READY = carregarTudo().catch(function (e) {
    console.error('[bridge] falha ao carregar dados do Supabase:', e);
    toast('Não consegui carregar seus dados da nuvem. Verifique sua conexão e recarregue a página.', 'erro');
  });

  // ------------------------------------------------------------------
  // DIAGNÓSTICO — digite RITTUS_DEBUG() no Console do navegador (F12) e
  // tire um print. Ajuda a comparar dois aparelhos: se `organizacao` ou
  // `codigoEquipe` vierem diferentes nos dois, cada aparelho está numa
  // conta separada — não é bug de sincronização, é login em contas
  // diferentes (o 2º cadastro precisa do "Código da equipe" do 1º).
  // ------------------------------------------------------------------
  window.RITTUS_DEBUG = function () {
    var info = {
      logado: !!window.__userId,
      organizacaoId: window.__orgId,
      organizacao: window.__orgInfo ? window.__orgInfo.nome : '(não carregado)',
      codigoEquipe: window.__orgInfo ? window.__orgInfo.codigo_convite : '(não carregado)',
      usuario: window.__perfil ? (window.__perfil.nome + ' — ' + window.__perfil.papel) : '(não carregado)',
      cachePronto: window.__cacheReady,
      totaisNoCache: {},
    };
    Object.keys(window.__cache || {}).forEach(function (k) {
      if (k.indexOf('__') === 0) return;
      var v = window.__cache[k];
      info.totaisNoCache[k] = Array.isArray(v) ? v.length + ' registro(s)' : typeof v;
    });
    console.log('[RITTUS_DEBUG]', info);
    return info;
  };
})();
