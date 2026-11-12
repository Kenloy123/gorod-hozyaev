-- КОЗЫРЬ: база данных. Вставить целиком в Supabase → SQL Editor → Run.
-- Можно запускать повторно — ничего не сломает.

create table if not exists players (
  pid         int primary key,                 -- публичный ID игрока (6 цифр)
  tg_id       bigint unique not null,          -- Telegram ID (никому не показывается)
  nick        text not null,
  avatar      text not null default 'p3',
  avatar_f    boolean not null default false,
  balance     bigint not null default 5000,
  wins        int not null default 0,
  games       int not null default 0,
  by_game     jsonb not null default '{}'::jsonb,
  last_bonus  timestamptz,
  earn_hour   timestamptz not null default now(),
  earned      bigint not null default 0,
  created_at  timestamptz not null default now(),
  seen_at     timestamptz not null default now()
);
create unique index if not exists players_nick_lower on players (lower(nick));
create index if not exists players_wins on players (wins desc);
create index if not exists players_balance on players (balance desc);

create table if not exists friends (
  pid        int not null references players(pid) on delete cascade,
  fid        int not null references players(pid) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (pid, fid)
);

-- Закрываем таблицы от прямого доступа: работать с ними может только наш сервер.
alter table players enable row level security;
alter table friends enable row level security;

-- Изменение баланса одной операцией. Выигрыш за час ограничен (защита от накрутки).
create or replace function apply_delta(p_pid int, p_delta bigint, p_cap bigint)
returns bigint language plpgsql as $$
declare b bigint; e bigint; h timestamptz; d bigint := p_delta;
begin
  select balance, earned, earn_hour into b, e, h from players where pid = p_pid for update;
  if not found then return null; end if;
  if h < now() - interval '1 hour' then e := 0; h := now(); end if;
  if d > 0 then d := least(d, greatest(0, p_cap - e)); e := e + d; end if;
  b := greatest(0, b + d);
  update players set balance = b, earned = e, earn_hour = h, seen_at = now() where pid = p_pid;
  return b;
end $$;

-- Ежедневный бонус (раз в 24 часа).
create or replace function take_bonus(p_pid int, p_amount bigint)
returns bigint language plpgsql as $$
declare b bigint;
begin
  update players set balance = balance + p_amount, last_bonus = now()
   where pid = p_pid and (last_bonus is null or last_bonus < now() - interval '24 hours')
  returning balance into b;
  return b;  -- null = ещё рано
end $$;

-- Запись победы / игры.
create or replace function add_stat(p_pid int, p_game text, p_won boolean)
returns void language plpgsql as $$
begin
  update players set
    games = games + 1,
    wins = wins + case when p_won then 1 else 0 end,
    by_game = case when p_won
      then jsonb_set(by_game, array[p_game], to_jsonb(coalesce((by_game->>p_game)::int, 0) + 1))
      else by_game end,
    seen_at = now()
  where pid = p_pid;
end $$;

revoke execute on function apply_delta(int, bigint, bigint) from public, anon, authenticated;
revoke execute on function take_bonus(int, bigint) from public, anon, authenticated;
revoke execute on function add_stat(int, text, boolean) from public, anon, authenticated;
grant execute on function apply_delta(int, bigint, bigint) to service_role;
grant execute on function take_bonus(int, bigint) to service_role;
grant execute on function add_stat(int, text, boolean) to service_role;

-- ===== Комнаты (игра с друзьями) =====
create table if not exists rooms (
  code       text primary key,
  game       text not null default 'durak',
  host       int  not null,
  stake      int  not null default 100,
  maxp       int  not null default 4,
  players    int[] not null default '{}',
  invited    int[] not null default '{}',
  status     text not null default 'wait',      -- wait / play / done
  state      jsonb,
  ver        int  not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rooms_invited on rooms using gin (invited);
create index if not exists rooms_players on rooms using gin (players);
alter table rooms enable row level security;

-- ===== Фото из Telegram =====
alter table players add column if not exists photo text;
