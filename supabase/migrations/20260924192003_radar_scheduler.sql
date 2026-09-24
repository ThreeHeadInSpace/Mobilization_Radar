-- Extensions are Supabase-managed. No job is activated until setup supplies Vault secrets.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create schema if not exists vault;
create extension if not exists supabase_vault with schema vault;
create function public.radar_tick() returns bigint language plpgsql set search_path=public,extensions as $$
declare endpoint text; token text; request_id bigint;
begin
 select decrypted_secret into endpoint from vault.decrypted_secrets where name='radar_app_url' limit 1;
 select decrypted_secret into token from vault.decrypted_secrets where name='radar_cron_secret' limit 1;
 if endpoint is null or token is null then raise exception 'scheduler not configured';end if;
 select net.http_post(url:=rtrim(endpoint,'/')||'/api/jobs',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),body:='{}'::jsonb,timeout_milliseconds:=1000) into request_id;
 return request_id;
end $$;
revoke all on function public.radar_tick() from public,anon,authenticated;
grant execute on function public.radar_tick() to service_role;
