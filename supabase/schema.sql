-- 학교일정위젯 데이터베이스 (Supabase SQL Editor에 통째로 붙여 넣고 Run)
-- PRD 13장 데이터 모델 중 로그인, 계정, 구분, 일정 부분이에요.
-- 반복 예외, 완료 체크, 공휴일, 학교 설정 표는 다음 단계에서 더해요.

-- ── 구분(부서) ──
create table public.categories (
  id          bigint generated always as identity primary key,
  name        text not null,
  color       text not null default '#4E79A7',
  sort_order  int  not null default 0,
  is_hidden   boolean not null default false
);

-- ── 교직원 계정 (auth.users와 1:1) ──
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  login_id             text not null unique,
  name                 text not null,
  default_category_id  bigint references public.categories (id),
  is_admin             boolean not null default false,
  is_active            boolean not null default true,
  must_change_password boolean not null default true,
  created_at           timestamptz not null default now()
);

-- ── 일정 ──
create table public.events (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (length(trim(title)) > 0),
  category_id   bigint not null references public.categories (id),
  start_date    date not null,
  end_date      date not null,
  start_time    time,
  end_time      time,
  location      text,
  memo          text,
  repeat        text not null default 'none' check (repeat in ('none', 'weekly', 'monthly')),
  repeat_until  date,
  author_id     uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_date >= start_date)
);
create index events_dates on public.events (start_date, end_date);

-- ── 도우미 함수 ──
-- 지금 로그인한 사람이 사용 중인 관리자인지
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin and is_active from public.profiles where id = auth.uid()), false)
$$;

-- 처음 비밀번호를 바꾼 뒤 본인 표시를 지워요
create function public.mark_password_changed() returns void
language sql security definer set search_path = public as $$
  update public.profiles set must_change_password = false where id = auth.uid()
$$;

-- 계정이 만들어지면 profiles 줄을 자동으로 만들어요.
-- 맨 처음 계정은 관리자가 되고, 대시보드에서 직접 비밀번호를 정했으니 바꾸라고 하지 않아요.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  is_first boolean := not exists (select 1 from public.profiles);
begin
  insert into public.profiles (id, login_id, name, default_category_id, is_admin, must_change_password)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'login_id', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data ->> 'default_category_id', '')::bigint,
    is_first,
    not is_first
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 일정을 고치면 updated_at을 바꿔요
create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger events_touch before update on public.events
  for each row execute function public.touch_updated_at();

-- ── 권한 (RLS) ──
alter table public.categories enable row level security;
alter table public.profiles   enable row level security;
alter table public.events     enable row level security;

create policy "로그인하면 구분을 볼 수 있어요" on public.categories
  for select to authenticated using (true);
create policy "관리자만 구분을 바꿔요" on public.categories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "로그인하면 계정 목록을 볼 수 있어요" on public.profiles
  for select to authenticated using (true);
-- 계정 추가, 수정은 관리자용 Edge Function(service role)으로만 해요.

create policy "로그인하면 모든 일정을 볼 수 있어요" on public.events
  for select to authenticated using (true);
create policy "일정은 자기 이름으로만 입력해요" on public.events
  for insert to authenticated with check (author_id = auth.uid());
create policy "자기 일정과 관리자만 고쳐요" on public.events
  for update to authenticated
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());
create policy "자기 일정과 관리자만 지워요" on public.events
  for delete to authenticated using (author_id = auth.uid() or public.is_admin());

grant select on public.categories, public.profiles, public.events to authenticated;
grant insert, update, delete on public.categories, public.events to authenticated;
grant execute on function public.is_admin(), public.mark_password_changed() to authenticated;

-- 다른 사람이 일정을 바꾸면 바로 알려 주도록 실시간 반영을 켜요
alter publication supabase_realtime add table public.events;

-- ── 구분 초기 목록 (지금 쓰는 주간업무 시트 기준 20개) ──
insert into public.categories (name, color, sort_order) values
  ('교무운영',         '#4E79A7',  1),
  ('교육과정',         '#F28E2B',  2),
  ('교육연구부',       '#E15759',  3),
  ('입학홍보',         '#76B7B2',  4),
  ('정보생활지원',     '#59A14F',  5),
  ('스마트팜과',       '#EDC948',  6),
  ('바이오식품과',     '#B07AA1',  7),
  ('직업교육부',       '#FF9DA7',  8),
  ('진로상담부',       '#9C755F',  9),
  ('현장실습취업부',   '#1F77B4', 10),
  ('동물자원연구센터', '#2CA02C', 11),
  ('반려동물과',       '#D62728', 12),
  ('학생생활안전부',   '#9467BD', 13),
  ('건강생활부',       '#8C564B', 14),
  ('행정실',           '#E377C2', 15),
  ('교감',             '#17BECF', 16),
  ('교장',             '#BCBD22', 17),
  ('복무',             '#7F7F7F', 18),
  ('방과후',           '#AEC7E8', 19),
  ('진행업무',         '#FFBB78', 20);
