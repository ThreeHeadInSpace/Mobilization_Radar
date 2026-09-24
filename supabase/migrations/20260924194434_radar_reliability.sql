create or replace function public.radar_tick() returns bigint language plpgsql set search_path=public,extensions as $$
declare endpoint text; token text; request_id bigint;
begin
 select decrypted_secret into endpoint from vault.decrypted_secrets where name='radar_app_url' limit 1;
 select decrypted_secret into token from vault.decrypted_secrets where name='radar_cron_secret' limit 1;
 if endpoint is null or token is null then raise exception 'scheduler not configured';end if;
 select net.http_post(url:=rtrim(endpoint,'/')||'/api/jobs',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),body:='{}'::jsonb,timeout_milliseconds:=240000) into request_id;
 return request_id;
end $$;
create or replace function public.radar_finish_publication(p_summary uuid,p_attempt uuid,p_message bigint,p_channel text) returns void language plpgsql set search_path=public as $$
declare q public.publication_queue;
begin
 select * into q from publication_queue where summary_id=p_summary for update;
 if q.status='published' and q.attempt_id=p_attempt and q.telegram_message_id=p_message and q.telegram_channel_id=p_channel then return;end if;
 update publication_queue set status='published',published_at=now(),telegram_message_id=p_message,telegram_channel_id=p_channel where summary_id=p_summary and attempt_id=p_attempt and status in ('sending','unknown');
 if not found then raise exception 'publication state mismatch';end if;
 update summaries set published_at=now() where id=p_summary;
 insert into audit_log(action_key,action,actor,data) values('published:'||p_summary,'published','publisher',jsonb_build_object('message_id',p_message)) on conflict do nothing;
end $$;
