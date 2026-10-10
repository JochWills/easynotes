-- EasyNotes schema. Run once in Supabase > SQL Editor.
-- The app talks to Supabase only from the server with the service role key.
-- RLS is enabled with no policies, so the public anon key can read/write nothing.

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null default 'seller' check (role in ('seller','admin')),
  created_at timestamptz not null default now()
);

create table if not exists sellers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  display_name text not null,
  full_name text, -- private: the seller's real name (account, emails, payouts)
  avatar_path text, -- profile picture in the samples bucket (avatars/...)
  slug text not null unique,
  headline text,
  bio text,
  -- verification
  degree text,
  university text,
  graduation_year int,
  degree_doc_path text,
  id_doc_path text,
  verification_status text not null default 'unsubmitted'
    check (verification_status in ('unsubmitted','pending','approved','rejected')),
  verification_note text,
  submitted_at timestamptz,
  verified_at timestamptz,
  -- payouts (Paystack subaccount)
  paystack_subaccount_code text,
  business_name text,
  bank_code text,
  bank_name text,
  account_number_last4 text,
  created_at timestamptz not null default now()
);

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references sellers(id) on delete restrict,
  title text not null,
  slug text not null,
  description text not null,
  subject text not null,
  module_code text,
  university text not null,
  level text not null,
  price_cents int not null check (price_cents between 200 and 50000),
  page_count int,
  file_path text not null,
  file_size int,
  sample_path text,
  status text not null default 'draft' check (status in ('draft','published','unpublished','removed')),
  sales_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  note_id uuid not null references notes(id) on delete restrict,
  seller_id uuid not null references sellers(id) on delete restrict,
  email text not null,
  amount_cents int not null,
  platform_fee_cents int not null,
  seller_earnings_cents int not null,
  status text not null default 'pending' check (status in ('pending','paid','failed')),
  paystack_transaction_id text,
  paid_at timestamptz,
  download_count int not null default 0,
  last_download_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notes_public_idx on notes (status, created_at desc);
create index if not exists notes_seller_idx on notes (seller_id);
create index if not exists notes_university_idx on notes (university);
create index if not exists orders_seller_idx on orders (seller_id, status);
create index if not exists orders_note_idx on orders (note_id);
create index if not exists sellers_status_idx on sellers (verification_status);

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists notes_touch on notes;
create trigger notes_touch before update on notes for each row execute function touch_updated_at();

create or replace function increment_note_sales(p_note_id uuid) returns void
language sql as $$ update notes set sales_count = sales_count + 1 where id = p_note_id; $$;

create or replace function seller_totals(p_seller_id uuid)
returns table (sales bigint, earnings bigint)
language sql stable as $$
  select count(*), coalesce(sum(seller_earnings_cents), 0)
  from orders where seller_id = p_seller_id and status = 'paid';
$$;

create or replace function platform_totals()
returns table (sales bigint, gross bigint, fees bigint)
language sql stable as $$
  select count(*), coalesce(sum(amount_cents), 0), coalesce(sum(platform_fee_cents), 0)
  from orders where status = 'paid';
$$;

-- Only the server (service role) may call these.
revoke execute on function increment_note_sales(uuid) from public, anon, authenticated;
revoke execute on function seller_totals(uuid) from public, anon, authenticated;
revoke execute on function platform_totals() from public, anon, authenticated;
grant execute on function increment_note_sales(uuid) to service_role;
grant execute on function seller_totals(uuid) to service_role;
grant execute on function platform_totals() to service_role;

alter table users enable row level security;
alter table sellers enable row level security;
alter table notes enable row level security;
alter table orders enable row level security;

-- Storage buckets
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('notes', 'notes', false, 52428800, array['application/pdf']),
  ('samples', 'samples', true, 10485760, array['application/pdf','image/webp']),
  ('verification', 'verification', false, 10485760, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do nothing;

-- Activity log for the admin dashboard (webhooks received, approvals, removals, admin changes).
create table if not exists events (
  id bigint generated always as identity primary key,
  kind text not null,
  actor text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_kind_idx on events (kind, created_at desc);
alter table events enable row level security;

-- Cart checkouts: every order bought in one payment shares the Paystack reference in payment_ref.
alter table orders add column if not exists payment_ref text;
update orders set payment_ref = reference where payment_ref is null;
create index if not exists orders_payment_ref_idx on orders (payment_ref);

-- Sellers can delete notes. Sold notes are kept as 'deleted' so past buyers can still download them.
alter table notes drop constraint if exists notes_status_check;
alter table notes add constraint notes_status_check check (status in ('draft','published','unpublished','removed','deleted'));

-- Buyer's name, collected at checkout.
alter table orders add column if not exists buyer_name text;

-- Sellers' real names, separate from the storefront name
alter table sellers add column if not exists full_name text;

-- Seller profile pictures
alter table sellers add column if not exists avatar_path text;

-- Education: each seller verifies one or more qualifications (finished or still studying).
-- sellers.degree / university / graduation_year keep a copy of the highest verified one for display.
create table if not exists qualifications (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references sellers(id) on delete cascade,
  level text not null,
  name text not null,
  institution text not null,
  status text not null check (status in ('completed','in_progress')),
  year_completed int,
  current_year text,
  expected_completion text, -- 'YYYY-MM'
  honours text not null default 'none' check (honours in ('none','merit','cum_laude','summa_cum_laude')),
  average_mark int check (average_mark between 50 and 100),
  distinctions text, -- subjects passed with distinction
  reminded_at timestamptz, -- "finished yet?" email sent after the expected finish date
  doc_path text,
  record_path text,
  review_status text not null default 'pending' check (review_status in ('pending','approved','rejected','superseded')),
  review_note text,
  replaces_id uuid references qualifications(id) on delete set null,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists qualifications_seller_idx on qualifications(seller_id);
create index if not exists qualifications_review_idx on qualifications(review_status);
alter table qualifications enable row level security;

-- Existing sellers' degrees become their first qualification
insert into qualifications (seller_id, level, name, institution, status, year_completed, doc_path, review_status, submitted_at, reviewed_at)
select s.id,
  case when s.degree ilike '%phd%' or s.degree ilike '%doctor%' then 'Doctorate (PhD)'
       when s.degree ~* '(master|^m(com|sc|a|phil|eng|ba)\M)' then 'Master’s degree'
       when s.degree ilike '%hons%' or s.degree ilike '%honours%' or s.degree ilike '%pgdip%' or s.degree ilike '%postgrad%' then 'Honours degree or Postgraduate Diploma'
       else 'Bachelor’s degree' end,
  s.degree, coalesce(s.university, ''), 'completed', s.graduation_year, s.degree_doc_path,
  case s.verification_status when 'approved' then 'approved' when 'rejected' then 'rejected' else 'pending' end,
  coalesce(s.submitted_at, s.created_at), s.verified_at
from sellers s
where s.degree is not null and not exists (select 1 from qualifications q where q.seller_id = s.id);

-- Storefront reviews: one per seller per purchase, checked against the order (reference + email)
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references sellers(id) on delete cascade,
  payment_ref text not null,
  notes_bought text, -- titles of this seller's notes in that purchase, shown as "Bought: ..."
  rating int not null check (rating between 1 and 5),
  body text,
  reviewer_name text, -- "Thabo M." from the name given at checkout
  status text not null default 'published' check (status in ('published','hidden')),
  created_at timestamptz not null default now(),
  unique (seller_id, payment_ref)
);
create index if not exists reviews_seller_idx on reviews(seller_id, status);
alter table reviews enable row level security;

-- Sellers' email notification switches (Settings)
alter table sellers add column if not exists notify_sales boolean not null default true;
alter table sellers add column if not exists notify_reviews boolean not null default true;
