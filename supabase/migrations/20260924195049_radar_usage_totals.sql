create function public.radar_monthly_usage(p_month date) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('total',coalesce(sum(cost),0),'requests',count(*),'unknownCost',count(*) filter(where cost is null))
 from ai_usage where created_at>=p_month::timestamp at time zone 'UTC' and created_at<(p_month+interval '1 month')::timestamp at time zone 'UTC'
$$;
revoke all on function public.radar_monthly_usage(date) from public,anon,authenticated;
grant execute on function public.radar_monthly_usage(date) to service_role;
