-- Server-only data. JSONB holds versioned evidence packages; indexed columns enforce identity.
create table public.sources(id text primary key, name text not null, type text not null, base_url text not null unique, region text, collection_method text not null, active boolean not null default true, reliability_metadata jsonb not null default '{}', created_at timestamptz not null default now());
create table public.articles(id uuid primary key, source_id text not null references public.sources, canonical_url text not null unique, original_url text not null, title text not null, published_at timestamptz, discovered_at timestamptz not null, text text not null, content_hash text not null unique, region text, raw_metadata jsonb not null);
create table public.monitor_runs(id uuid primary key default gen_random_uuid(), idempotency_key text not null unique, trigger_type text not null, previous_run_id uuid references public.monitor_runs, status text not null default 'running', phase text not null default 'collect', state jsonb not null default '{}', started_at timestamptz not null default now(), finished_at timestamptz, items_checked int not null default 0, items_new int not null default 0, findings_created int not null default 0, collector_errors jsonb not null default '[]');
create unique index one_active_run on public.monitor_runs((true)) where status='running';
create table public.collector_runs(id bigint generated always as identity primary key, run_id uuid not null references public.monitor_runs, source_id text not null references public.sources, result jsonb not null, unique(run_id,source_id));
create table public.run_articles(run_id uuid not null references public.monitor_runs, article_id uuid not null references public.articles, triage jsonb, primary key(run_id,article_id));
create table public.findings(id text primary key, data jsonb not null, first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now());
create table public.finding_sources(finding_id text not null references public.findings, article_id uuid not null references public.articles, data jsonb not null, primary key(finding_id,article_id));
create table public.signal_snapshots(id bigint generated always as identity primary key, run_id uuid not null references public.monitor_runs, scope_type text not null, region text not null default '', data jsonb not null, unique(run_id,scope_type,region));
create table public.run_reports(run_id uuid primary key references public.monitor_runs, data jsonb not null, created_at timestamptz not null default now());
create table public.official_baseline(id text primary key references public.findings, data jsonb not null, recorded_at timestamptz not null default now());
create table public.summaries(id uuid primary key default gen_random_uuid(), public_id text not null unique, report_date date not null, run_id uuid not null references public.monitor_runs, data jsonb not null, review_status text not null, superseded boolean not null default false, created_at timestamptz not null default now(), published_at timestamptz);
create unique index one_daily_report on public.summaries(report_date) where not superseded;
create table public.summary_sources(id bigint generated always as identity primary key, summary_id uuid not null references public.summaries, ordinal int not null, data jsonb not null, unique(summary_id,ordinal));
create table public.publication_queue(summary_id uuid primary key references public.summaries, status text not null check(status in ('review','ready','sending','published','rejected','unknown','failed')), requires_review boolean not null, reviewed_at timestamptz, published_at timestamptz, telegram_message_id bigint, telegram_channel_id text, attempt_id uuid, started_at timestamptz);
create table public.ai_usage(id bigint generated always as identity primary key, run_id uuid references public.monitor_runs, provider text not null, model text not null, operation text not null, input_tokens bigint, output_tokens bigint, cost numeric, duration int not null, success boolean not null, error_code text, created_at timestamptz not null default now());
create table public.audit_log(id bigint generated always as identity primary key, action_key text not null unique, action text not null, actor text not null, data jsonb not null default '{}', created_at timestamptz not null default now());
create table public.config(key text primary key, value jsonb not null);
create table public.job_locks(name text primary key, owner uuid not null, expires_at timestamptz not null);
create table public.admin_jobs(id text primary key, summary_id uuid not null references public.summaries, status text not null default 'pending', created_at timestamptz not null default now());
create index articles_time on public.articles(discovered_at desc);
create index run_articles_article on public.run_articles(article_id);
create index finding_sources_article on public.finding_sources(article_id);
create index summaries_run on public.summaries(run_id);
create index monitor_runs_previous on public.monitor_runs(previous_run_id);
create index usage_time on public.ai_usage(created_at);
create index usage_run on public.ai_usage(run_id);

create function public.radar_lock(p_name text,p_owner uuid,p_seconds int) returns boolean language plpgsql set search_path=public as $$
begin
 insert into job_locks values(p_name,p_owner,now()+make_interval(secs=>p_seconds)) on conflict(name) do update set owner=excluded.owner,expires_at=excluded.expires_at where job_locks.expires_at<now();
 return found;
end $$;
create function public.radar_unlock(p_name text,p_owner uuid) returns void language sql set search_path=public as $$ delete from job_locks where name=p_name and owner=p_owner $$;

create function public.radar_save_report(p_run uuid,p_report jsonb) returns void language plpgsql set search_path=public as $$
declare e jsonb; ev jsonb; r record;
begin
 for e in select * from jsonb_array_elements(p_report->'events') loop
  insert into findings(id,data) values(e->>'canonicalKey',e) on conflict(id) do update set data=excluded.data,last_seen_at=now();
  for ev in select * from jsonb_array_elements(e->'evidence') loop
   insert into finding_sources values(e->>'canonicalKey',(ev->>'articleId')::uuid,ev) on conflict(finding_id,article_id) do update set data=excluded.data;
  end loop;
  if (e->>'freshOfficial')::boolean then insert into official_baseline(id,data) values(e->>'canonicalKey',e) on conflict do nothing; end if;
 end loop;
 insert into signal_snapshots(run_id,scope_type,data) values(p_run,'federal',p_report->'federalSignal') on conflict do nothing;
 for r in select * from jsonb_each(p_report->'regionalSignals') loop insert into signal_snapshots(run_id,scope_type,region,data) values(p_run,'region',r.key,r.value) on conflict do nothing; end loop;
 insert into run_reports(run_id,data) values(p_run,p_report) on conflict do nothing;
 update monitor_runs set status=p_report->>'runStatus',phase='done',finished_at=now(),findings_created=jsonb_array_length(p_report->'events') where id=p_run;
end $$;

create function public.radar_stage(p_run uuid,p_report jsonb) returns uuid language plpgsql set search_path=public as $$
declare sid uuid; s jsonb; n int:=0;
begin
 insert into summaries(public_id,report_date,run_id,data,review_status) values(p_report->>'publicId',(p_report->>'reportDate')::date,p_run,p_report,p_report->>'reviewState') on conflict(report_date) where not superseded do nothing returning id into sid;
 if sid is null then return null; end if;
 for s in select * from jsonb_array_elements(p_report->'sources') loop n:=n+1;insert into summary_sources(summary_id,ordinal,data) values(sid,n,s);end loop;
 insert into publication_queue(summary_id,status,requires_review) values(sid,case when (p_report->>'reviewRequired')::boolean then 'review' else 'ready' end,(p_report->>'reviewRequired')::boolean);
 return sid;
end $$;

create function public.radar_immutable() returns trigger language plpgsql set search_path=public as $$
begin
 if TG_TABLE_NAME='summary_sources' then
  if TG_OP='INSERT' and not exists(select 1 from publication_queue where summary_id=new.summary_id) then return new; end if;
  raise exception 'immutable source snapshot';
 end if;
 if TG_OP='DELETE' then raise exception 'immutable report'; end if;
 if old.published_at is not null and (new.superseded is distinct from old.superseded or new.published_at is distinct from old.published_at) then raise exception 'published report is final';end if;
 if new.data is distinct from old.data or new.public_id<>old.public_id or new.report_date<>old.report_date or new.run_id<>old.run_id then raise exception 'immutable report';end if;
 return new;
end $$;
create trigger immutable_sources before insert or update or delete on public.summary_sources for each row execute function public.radar_immutable();
create trigger immutable_summaries before update or delete on public.summaries for each row execute function public.radar_immutable();

create function public.radar_admin(p_public text,p_action text,p_actor text,p_key text) returns text language plpgsql set search_path=public as $$
declare sid uuid; st text;
begin
 select id into sid from summaries where public_id=p_public;
 if sid is null then return 'not_found';end if;
 select status into st from publication_queue where summary_id=sid for update;
 insert into audit_log(action_key,action,actor,data) values(p_key,p_action,p_actor,jsonb_build_object('summary_id',sid,'previous',st)) on conflict do nothing;
 if not found then return 'duplicate';end if;
 if p_action='reanalyze' and st in ('review','ready','rejected') then
  update publication_queue set status='rejected',reviewed_at=now() where summary_id=sid;
  insert into admin_jobs(id,summary_id) values(p_key,sid) on conflict do nothing;
  return 'queued';
 end if;
 if st<>'review' then return st;end if;
 if p_action='approve' then update publication_queue set status='ready',reviewed_at=now() where summary_id=sid;update summaries set review_status='APPROVED' where id=sid;return 'ready';
 elsif p_action='reject' then update publication_queue set status='rejected',reviewed_at=now() where summary_id=sid;update summaries set review_status='REJECTED' where id=sid;return 'rejected';end if;
 return 'ignored';
end $$;

create function public.radar_claim_publication(p_summary uuid,p_attempt uuid) returns boolean language plpgsql set search_path=public as $$
begin
 update publication_queue set status='sending',attempt_id=p_attempt,started_at=now() where summary_id=p_summary and status='ready';return found;
end $$;
create function public.radar_finish_publication(p_summary uuid,p_attempt uuid,p_message bigint,p_channel text) returns void language plpgsql set search_path=public as $$
begin
 update publication_queue set status='published',published_at=now(),telegram_message_id=p_message,telegram_channel_id=p_channel where summary_id=p_summary and attempt_id=p_attempt and status in ('sending','unknown');
 if not found then raise exception 'publication state mismatch';end if;
 update summaries set published_at=now() where id=p_summary;
 insert into audit_log(action_key,action,actor,data) values('published:'||p_summary,'published','publisher',jsonb_build_object('message_id',p_message)) on conflict do nothing;
end $$;

-- No anonymous or authenticated access, including RPC. Only backend service_role.
do $$ declare t text; f record; begin
 foreach t in array array['sources','articles','monitor_runs','collector_runs','run_articles','findings','finding_sources','signal_snapshots','run_reports','official_baseline','summaries','summary_sources','publication_queue','ai_usage','audit_log','config','job_locks','admin_jobs'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'radar_%' loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);end loop;
end $$;
grant usage,select on all sequences in schema public to service_role;
