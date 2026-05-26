-- Club Hub Prospect Engine V1: HubSpot CSV export schema.
-- Paste this full script into the Supabase SQL Editor and run it once.
-- It is idempotent and does not require any app-side execution.

do $$
declare
  prospect_id_type text;
begin
  select format_type(attribute.atttypid, attribute.atttypmod)
    into prospect_id_type
  from pg_attribute attribute
  join pg_class class on class.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = class.relnamespace
  where namespace.nspname = 'public'
    and class.relname = 'prospects'
    and attribute.attname = 'id'
    and not attribute.attisdropped;

  if prospect_id_type is null then
    raise exception 'public.prospects.id was not found.';
  end if;

  execute format(
    'create table if not exists public.prospect_contacts (
      id uuid primary key default gen_random_uuid(),
      prospect_id %s not null references public.prospects(id) on delete cascade,
      first_name text,
      last_name text,
      email text,
      phone_number text,
      job_title text,
      contact_owner text,
      lead_status text,
      contact_rank integer,
      sequence_pick boolean,
      sequence_name text,
      best_contact_reason text,
      email_validation_status text,
      contact_source_url text,
      contact_confidence text,
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )',
    prospect_id_type
  );
end $$;

create unique index if not exists prospect_contacts_prospect_email_key
on public.prospect_contacts (prospect_id, lower(email));

create index if not exists prospect_contacts_prospect_id_idx
on public.prospect_contacts (prospect_id);

create or replace function public.set_prospect_contacts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_prospect_contacts_updated_at on public.prospect_contacts;

create trigger set_prospect_contacts_updated_at
before update on public.prospect_contacts
for each row
execute function public.set_prospect_contacts_updated_at();

alter table public.prospects
  add column if not exists company_domain_name text,
  add column if not exists company_owner text,
  add column if not exists street_address text,
  add column if not exists state_region_code text,
  add column if not exists postal_code text,
  add column if not exists time_zone text,
  add column if not exists industry text,
  add column if not exists company_type text,
  add column if not exists record_source text,
  add column if not exists religion text,
  add column if not exists school_structure text,
  add column if not exists school_structure_boy_girl text,
  add column if not exists school_structure_day_boarding text,
  add column if not exists school_divisions text,
  add column if not exists low_grade text,
  add column if not exists high_grade text,
  add column if not exists number_of_students text,
  add column if not exists number_of_clubs text,
  add column if not exists list_of_clubs text,
  add column if not exists clubs_letter_grade text,
  add column if not exists percent_clubs_get_funding text,
  add column if not exists percent_lots_of_participation text,
  add column if not exists percent_plenty_of_clubs text,
  add column if not exists tuition text,
  add column if not exists niche_ranking text,
  add column if not exists number_of_employees_range text,
  add column if not exists annual_revenue text,
  add column if not exists subscription_year text,
  add column if not exists description text,
  add column if not exists linkedin_company_page text,
  add column if not exists reference_school text,
  add column if not exists reference_school_reason text,
  add column if not exists ai_fit_reason text,
  add column if not exists source_url text,
  add column if not exists data_confidence text,
  add column if not exists export_notes text,
  add column if not exists exported_at timestamptz;

update public.prospects
set
  company_owner = coalesce(nullif(trim(company_owner), ''), 'Paul Knox'),
  record_source = coalesce(nullif(trim(record_source), ''), 'Import'),
  industry = coalesce(nullif(trim(industry), ''), 'Education Management')
where company_owner is null
   or trim(company_owner) = ''
   or record_source is null
   or trim(record_source) = ''
   or industry is null
   or trim(industry) = '';

insert into public.prospect_contacts (
  prospect_id,
  first_name,
  last_name,
  email,
  phone_number,
  job_title,
  contact_owner,
  lead_status,
  contact_rank,
  sequence_pick,
  sequence_name,
  best_contact_reason,
  email_validation_status,
  contact_source_url,
  contact_confidence,
  notes
)
select
  prospects.id,
  split_part(trim(prospects.contact_name), ' ', 1),
  nullif(trim(regexp_replace(trim(prospects.contact_name), '^\S+\s*', '')), ''),
  lower(trim(prospects.contact_email)),
  prospects.contact_phone,
  prospects.contact_title,
  'Paul Knox',
  'New',
  1,
  true,
  'Club Hub - V1 School Outreach',
  null,
  case
    when lower(coalesce(prospects.email_validation_status, prospects.contact_email_validation_status, '')) in ('valid', 'passed') then 'Valid'
    when lower(coalesce(prospects.email_validation_status, prospects.contact_email_validation_status, '')) in ('invalid', 'failed') then 'Error'
    when lower(coalesce(prospects.email_validation_status, prospects.contact_email_validation_status, '')) = 'error' then 'Error'
    else 'Unknown'
  end,
  prospects.contact_source_url,
  prospects.contact_confidence::text,
  null
from public.prospects
where nullif(trim(prospects.contact_email), '') is not null
  and split_part(trim(coalesce(prospects.contact_name, '')), ' ', 1) <> ''
  and not exists (
    select 1
    from public.prospect_contacts existing
    where existing.prospect_id = prospects.id
      and lower(existing.email) = lower(trim(prospects.contact_email))
  );
