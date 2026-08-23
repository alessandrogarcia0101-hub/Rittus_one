/* ====================================================================
   RITTUS ONE — configuração (fonte única, usada por index.html E app.html)
   ------------------------------------------------------------------
   Script CLÁSSICO (sem "export") de propósito: o app.html grande é um
   script clássico (não é módulo ES) porque suas ~290 funções precisam
   ficar em `window` para os `onclick="..."` do HTML funcionarem. Um
   config.js com `export const` quebraria com "Unexpected token export"
   se carregado assim. Por isso este arquivo só define variáveis globais
   — tanto index.html quanto app.html carregam ESTE MESMO arquivo (nada
   de duplicar a URL/chave em dois lugares, que foi um bug encontrado na
   primeira versão do projeto).

   Troque os dois valores abaixo pelas suas credenciais reais do Supabase
   (Project Settings → API, em supabase.com/dashboard). A "anon key" é
   pública por design — pode ficar no front-end; toda a segurança real
   vem do Row Level Security (RLS) configurado nos arquivos .sql.
   ==================================================================== */

window.RITTUS_SUPABASE_URL = "https://pahobnxwpvpdripdygox.supabase.co";
window.RITTUS_SUPABASE_ANON_KEY = "sb_publishable_aILsQwyQOaa-CwjStp9oew_ryDK6wb4";

window.RITTUS_CONFIGURADO =
  window.RITTUS_SUPABASE_URL.indexOf("https://") === 0 &&
  window.RITTUS_SUPABASE_URL.indexOf("SEU-PROJETO") === -1 &&
  window.RITTUS_SUPABASE_ANON_KEY.length > 20 &&
  window.RITTUS_SUPABASE_ANON_KEY.indexOf("SUA-CHAVE") === -1;

if (!window.RITTUS_CONFIGURADO) {
  console.warn(
    '[RITTUS ONE] config.js ainda não foi preenchido com as credenciais reais do Supabase. ' +
    'Edite RITTUS_SUPABASE_URL e RITTUS_SUPABASE_ANON_KEY em config.js.'
  );
}
