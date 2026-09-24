-- Confirmations are not queued jobs. Only an accepted confirmation creates a running run.
create table public.manual_review_requests (
 token uuid primary key,
 actor text not null,
 status text not null check(status in ('confirmation_required','started','cancelled','already_running','expired')),
 run_id uuid references public.monitor_runs,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '15 minutes'
);
alter table public.manual_review_requests enable row level security;
revoke all on public.manual_review_requests from public,anon,authenticated;
grant all on public.manual_review_requests to service_role;

create function public.radar_manual_review(p_action text,p_token uuid,p_actor text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare req public.manual_review_requests; rid uuid; previous uuid;
begin
 if p_action not in ('prepare','confirm','cancel','direct') or length(p_actor)=0 then
  return jsonb_build_object('status','invalid_request');
 end if;
 -- Serialize with all inserts into monitor_runs, including the scheduled worker.
 lock table public.monitor_runs in share row exclusive mode;
 select * into req from public.manual_review_requests where token=p_token for update;
 if found then
  if req.actor<>p_actor then return jsonb_build_object('status','invalid_confirmation'); end if;
  if req.status<>'confirmation_required' then
   return jsonb_strip_nulls(jsonb_build_object('status',req.status,'runId',req.run_id));
  end if;
  if req.expires_at<=now() then
   update public.manual_review_requests set status='expired' where token=p_token;
   return jsonb_build_object('status','expired');
  end if;
 elsif p_action in ('confirm','cancel') then
  return jsonb_build_object('status','invalid_confirmation');
 end if;
 if p_action='cancel' then
  update public.manual_review_requests set status='cancelled' where token=p_token;
  return jsonb_build_object('status','cancelled');
 end if;
 if exists(select 1 from public.monitor_runs where status='running') then
  -- A blocked confirmation is consumed, never deferred for a later callback retry.
  select id into rid from public.monitor_runs where status='running';
  insert into public.manual_review_requests(token,actor,status,run_id) values(p_token,p_actor,'already_running',rid)
   on conflict(token) do update set status='already_running',run_id=rid;
  return jsonb_build_object('status','already_running');
 end if;
 if p_action='prepare' then
  insert into public.manual_review_requests(token,actor,status) values(p_token,p_actor,'confirmation_required') on conflict do nothing;
  return jsonb_build_object('status','confirmation_required');
 end if;
 select id into previous from public.monitor_runs order by started_at desc limit 1;
 insert into public.monitor_runs(idempotency_key,trigger_type,previous_run_id,state)
 values('manual-review:'||p_token,'manual-review',previous,'{"reviewOnly":true}') returning id into rid;
 insert into public.manual_review_requests(token,actor,status,run_id) values(p_token,p_actor,'started',rid)
 on conflict(token) do update set status='started',run_id=rid;
 return jsonb_build_object('status','started','runId',rid,'fresh',true);
end $$;
revoke all on function public.radar_manual_review(text,uuid,text) from public,anon,authenticated;
grant execute on function public.radar_manual_review(text,uuid,text) to service_role;

-- Defense in depth: manual reports cannot enter the public daily publication queue.
create function public.radar_manual_publication_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from public.monitor_runs where id=new.run_id and trigger_type='manual-review') then
  raise exception 'manual_review_is_private';
 end if;
 return new;
end $$;
revoke all on function public.radar_manual_publication_guard() from public,anon,authenticated;
grant execute on function public.radar_manual_publication_guard() to service_role;
create trigger manual_review_is_private before insert on public.summaries
for each row execute function public.radar_manual_publication_guard();
