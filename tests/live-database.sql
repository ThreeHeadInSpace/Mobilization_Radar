-- Safe live integration smoke: all fixture writes are rolled back.
begin;
do $$
declare rid uuid:=gen_random_uuid(); sid uuid; attempt uuid:=gen_random_uuid(); report jsonb; result text;
begin
 insert into public.monitor_runs(id,idempotency_key,trigger_type,status) values(rid,'rollback-smoke:'||rid,'smoke','completed');
 report:=jsonb_build_object('publicId',replace(rid::text,'-',''),'reportDate','1900-01-01','reviewState','REVIEW_REQUIRED','reviewRequired',true,'events','[]'::jsonb,'regionalSignals','{}'::jsonb,'sources',jsonb_build_array(jsonb_build_object('url','https://example.org/rollback-fixture','title','rollback-only')));
 sid:=public.radar_stage(rid,report);
 if sid is null then raise exception 'fixture date occupied';end if;
 if public.radar_stage(rid,report) is not null then raise exception 'duplicate report';end if;
 begin update public.summary_sources set data='{}' where summary_id=sid;raise exception 'snapshot was mutable';exception when others then if SQLERRM='snapshot was mutable' then raise;end if;end;
 begin insert into public.summary_sources(summary_id,ordinal,data) values(sid,2,'{}');raise exception 'snapshot accepted new row';exception when others then if SQLERRM='snapshot accepted new row' then raise;end if;end;
 result:=public.radar_admin(report->>'publicId','approve','smoke','rollback-approval:'||rid);
 if result<>'ready' then raise exception 'approval failed';end if;
 if public.radar_admin(report->>'publicId','approve','smoke','rollback-approval:'||rid)<>'duplicate' then raise exception 'approval duplicated';end if;
 if not public.radar_claim_publication(sid,attempt) then raise exception 'claim failed';end if;
 if public.radar_claim_publication(sid,gen_random_uuid()) then raise exception 'double claim';end if;
 perform public.radar_finish_publication(sid,attempt,1,'rollback-only');
 if not exists(select 1 from public.summaries where id=sid and published_at is not null) then raise exception 'completion failed';end if;
end $$;
rollback;
