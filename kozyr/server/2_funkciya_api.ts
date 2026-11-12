// КОЗЫРЬ: сервер (Supabase Edge Function с именем "api").
// Вставить целиком в редактор функции и нажать Deploy.
// Нужен секрет TG_BOT_TOKEN (токен бота из BotFather) — вставляется в Supabase, никому не отправлять.
// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TOKEN = (Deno.env.get("TG_BOT_TOKEN") ?? "").trim();

const START_BALANCE = 5000;
const BONUS = 2000;
const HOUR_CAP = 1_000_000;     // сколько максимум можно выиграть за час
const MAX_STEP = 500_000;       // максимальное изменение баланса за один раз
const GAMES = ["poker", "durak", "kozel", "roul"];
const NICK_RE = /^[A-Za-zА-Яа-яЁё0-9_ ]{3,16}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const out = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });

// ---------- проверка, что запрос пришёл из Telegram ----------
const enc = new TextEncoder();
async function hmac(key: Uint8Array, msg: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function tgUser(initData: string) {
  if (!initData || !TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), TOKEN);
  if (hex(await hmac(secret, check)) !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 30 * 86400) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

// ---------- помощники ----------
const PUB = "pid,nick,avatar,avatar_f,wins,games,balance,by_game,seen_at,photo";
const photoOf = (r: any) => (r.avatar === "tg" && r.photo ? r.photo : null);
const okPhoto = (u: any) => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) && u.length < 500 ? u : null);
const ONLINE_MS = 150_000;
const isOn = (t: string) => !!t && Date.now() - Date.parse(t) < ONLINE_MS;
const fav = (by: Record<string, number>) => {
  const e = Object.entries(by || {}).sort((a, b) => b[1] - a[1])[0];
  return e ? e[0] : null;
};
const pub = (r: any) => r && ({ pid: r.pid, nick: r.nick, avatar: r.avatar, avatar_f: r.avatar_f, wins: r.wins, games: r.games, balance: r.balance, fav: fav(r.by_game), online: isOn(r.seen_at), seen: r.seen_at, photo: photoOf(r) });
const cleanNick = (s: string) => (s || "").replace(/[^A-Za-zА-Яа-яЁё0-9_ ]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);

async function nickFree(nick: string, exceptPid?: number) {
  const { data } = await db.from("players").select("pid").ilike("nick", nick.replace(/[\\%_]/g, (c) => "\\" + c));
  return !(data || []).some((r) => r.pid !== exceptPid);
}

async function createPlayer(user: any) {
  let base = cleanNick(user.first_name || user.username || "");
  for (let tries = 0; tries < 30; tries++) {
    const pid = 100000 + Math.floor(Math.random() * 900000);
    let nick = base.length >= 3 ? base : "Игрок" + String(pid).slice(-4);
    if (!(await nickFree(nick))) nick = (nick.slice(0, 11) + " " + String(pid).slice(-4)).trim();
    const { data, error } = await db.from("players")
      .insert({ pid, tg_id: user.id, nick, balance: START_BALANCE, photo: okPhoto(user.photo_url), avatar: okPhoto(user.photo_url) ? "tg" : "p3" })
      .select("*").single();
    if (!error) return data;
    if (String(error.message).includes("tg_id")) {
      const { data: ex } = await db.from("players").select("*").eq("tg_id", user.id).single();
      return ex;
    }
  }
  throw new Error("не удалось создать игрока");
}

async function friendsOf(pid: number) {
  const { data: rows } = await db.from("friends").select("fid").eq("pid", pid);
  const ids = (rows || []).map((r) => r.fid);
  if (!ids.length) return [];
  const { data } = await db.from("players").select(PUB).in("pid", ids);
  return (data || []).map(pub).sort((a, b) => Number(b.online) - Number(a.online));
}

// ===== ДУРАК: движок на сервере (общий для всех игроков комнаты) =====
// Карта: {r: 6..14, s: 0..3}
const DK = {
  shuffle() {
    const d = [];
    for (let r = 6; r <= 14; r++) for (let s = 0; s < 4; s++) d.push({ r, s });
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    return d;
  },
  init(n, stake) {
    const st = { n, stake, deck: DK.shuffle(), hands: [], table: [], passed: [], out: [], places: [], taking: false,
      disc: 0, over: false, fool: -1, msg: "", turnAt: Date.now(), settled: false, res: null, last: null };
    for (let i = 0; i < n; i++) { st.hands.push([]); st.out.push(false); }
    for (let k = 0; k < 6; k++) for (let i = 0; i < n; i++) st.hands[i].push(st.deck.pop());
    st.trumpCard = st.deck[0]; st.trump = st.trumpCard.s;
    let best = 99, first = Math.floor(Math.random() * n);
    st.hands.forEach((h, i) => h.forEach((c) => { if (c.s === st.trump && c.r < best) { best = c.r; first = i; } }));
    st.att = first; st.def = DK.next(st, first);
    st.msg = "Первым ходит игрок с младшим козырем";
    DK.advance(st);
    return st;
  },
  beats(st, x, y) { return (x.s === y.s && x.r > y.r) || (x.s === st.trump && y.s !== st.trump); },
  next(st, i) { for (let k = 1; k <= st.n; k++) { const j = (i + k) % st.n; if (!st.out[j] && j !== i) return j; } return i; },
  attOrder(st) {
    const res = [st.att]; let j = st.att;
    for (let k = 1; k < st.n; k++) { j = (j + 1) % st.n; if (j !== st.def && j !== st.att && !st.out[j]) res.push(j); }
    return res;
  },
  unbeaten(st) { return st.table.filter((x) => !x.d); },
  canThrow(st, c) {
    if (st.table.length >= 6) return false;
    if (DK.unbeaten(st).length >= st.hands[st.def].length) return false;
    if (!st.table.length) return true;
    return st.table.some((x) => x.a.r === c.r || (x.d && x.d.r === c.r));
  },
  advance(st) {
    for (let guard = 0; guard < 50 && !st.over; guard++) {
      if (!st.taking && DK.unbeaten(st).length) { st.cur = st.def; st.mode = "def"; return; }
      const order = DK.attOrder(st).filter((i) => !st.passed.includes(i));
      let found = -1;
      for (const i of order) {
        if (st.table.length && !st.hands[i].some((c) => DK.canThrow(st, c))) { st.passed.push(i); continue; }
        found = i; break;
      }
      if (found >= 0) { st.cur = found; st.mode = "att"; return; }
      DK.endBout(st);
    }
  },
  endBout(st) {
    const def = st.def;
    if (st.taking) { st.table.forEach((x) => { st.hands[def].push(x.a); if (x.d) st.hands[def].push(x.d); }); st.last = { t: "take", i: def }; }
    else { st.disc += st.table.length * 2; st.last = { t: "bito" }; }
    st.table = [];
    const order = DK.attOrder(st); if (!order.includes(def)) order.push(def);
    order.forEach((i) => { while (st.hands[i].length < 6 && st.deck.length) st.hands[i].push(st.deck.pop()); });
    if (!st.deck.length) st.hands.forEach((h, i) => { if (!st.out[i] && !h.length) { st.out[i] = true; st.places.push(i); } });
    const left = []; st.out.forEach((o, i) => { if (!o) left.push(i); });
    if (left.length <= 1) { st.over = true; st.fool = left.length ? left[0] : -1; st.cur = -1; st.mode = ""; return; }
    const took = st.taking; st.taking = false; st.passed = [];
    st.att = took ? DK.next(st, def) : (st.out[def] ? DK.next(st, def) : def);
    st.def = DK.next(st, st.att);
  },
  // действие игрока i; возвращает текст ошибки или ""
  act(st, i, a, card) {
    if (st.over) return "игра окончена";
    if (st.cur !== i) return "не твой ход";
    if (a === "card") {
      const h = st.hands[i]; const k = h.findIndex((c) => c.r === card?.r && c.s === card?.s);
      if (k < 0) return "нет такой карты";
      const c = h[k];
      if (st.mode === "def") {
        const t = st.table.find((x) => !x.d && DK.beats(st, c, x.a));
        if (!t) return "этой картой не побить";
        t.d = c; h.splice(k, 1); st.last = { t: "def", i };
      } else {
        if (!DK.canThrow(st, c)) return "так ходить нельзя";
        st.table.push({ a: c }); h.splice(k, 1); st.last = { t: "att", i };
      }
      st.passed = [];
    } else if (a === "take") {
      if (st.mode !== "def") return "сейчас нельзя взять";
      st.taking = true; st.passed = []; st.last = { t: "taking", i };
    } else if (a === "pass") {
      if (st.mode !== "att" || !st.table.length) return "сейчас нельзя";
      st.passed.push(i); st.last = { t: "pass", i };
    } else return "неизвестное действие";
    st.turnAt = Date.now();
    DK.advance(st);
    return "";
  },
  // если игрок долго не ходит — ход за него
  timeout(st, ms) {
    if (st.over || st.cur < 0 || Date.now() - st.turnAt < ms) return false;
    const i = st.cur, h = st.hands[i];
    if (st.mode === "def") DK.act(st, i, "take");
    else if (!st.table.length) { const c = h.slice().sort((x, y) => (x.s === st.trump) - (y.s === st.trump) || x.r - y.r)[0]; DK.act(st, i, "card", c); }
    else DK.act(st, i, "pass");
    return true;
  },
  view(st, i) {
    return { n: st.n, me: i, hand: st.hands[i], counts: st.hands.map((h) => h.length), out: st.out, table: st.table,
      deckCount: st.deck.length, trumpCard: st.trumpCard, trump: st.trump, att: st.att, def: st.def, taking: st.taking,
      cur: st.cur, mode: st.mode, disc: st.disc, over: st.over, fool: st.fool, res: st.res, last: st.last,
      turnLeft: st.over ? 0 : Math.max(0, Math.round((45000 - (Date.now() - st.turnAt)) / 1000)) };
  },
};

// ---------- комнаты ----------
const ROOM_STAKES = [100, 500, 1000, 5000];
const TURN_MS = 45000;
const CODE_CH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 5 }, () => CODE_CH[Math.floor(Math.random() * CODE_CH.length)]).join("");
async function getRoom(code: string) {
  const { data } = await db.from("rooms").select("*").eq("code", String(code || "").toUpperCase()).maybeSingle();
  return data;
}
// сохранить комнату, только если её никто не изменил параллельно
async function saveRoom(room: any, patch: any) {
  const { data } = await db.from("rooms").update({ ...patch, ver: room.ver + 1, updated_at: new Date().toISOString() })
    .eq("code", room.code).eq("ver", room.ver).select("*").maybeSingle();
  return data;
}
async function roomPlayers(pids: number[]) {
  if (!pids.length) return [];
  const { data } = await db.from("players").select("pid,nick,avatar,avatar_f,wins,balance,seen_at,photo").in("pid", pids);
  return pids.map((id) => (data || []).find((r) => r.pid === id)).filter(Boolean).map((r) => ({ ...r, online: isOn(r.seen_at), photo: photoOf(r) }));
}
// подсчитать итог (без денег) — деньги переводятся только после успешного сохранения
function settle(room: any, st: any) {
  if (st.settled || !st.over) return false;
  st.settled = true;
  const res: Record<number, number> = {};
  if (st.fool >= 0) {
    const others = room.players.filter((_: number, i: number) => i !== st.fool);
    for (const p of others) res[p] = st.stake;
    res[room.players[st.fool]] = -st.stake * others.length;
  }
  st.res = res;
  return true;
}
async function pay(room: any) {
  const st = room.state;
  for (const [p, d] of Object.entries(st.res || {})) await db.rpc("apply_delta", { p_pid: Number(p), p_delta: d, p_cap: 1e12 });
  for (let i = 0; i < room.players.length; i++) await db.rpc("add_stat", { p_pid: room.players[i], p_game: "durak", p_won: i !== st.fool });
}
async function roomOut(room: any, pid: number) {
  const st = room.state;
  const idx = room.players.indexOf(pid);
  return {
    room: { code: room.code, game: room.game, host: room.host, stake: room.stake, maxp: room.maxp, status: room.status, ver: room.ver,
      players: await roomPlayers(room.players), invited: room.invited },
    view: st && idx >= 0 ? DK.view(st, idx) : null,
  };
}
async function roomAction(a: string, body: any, me: any) {
  const pid = me.pid;
  if (a === "room_create") {
    const stake = ROOM_STAKES.includes(Number(body.stake)) ? Number(body.stake) : 100;
    for (let t = 0; t < 10; t++) {
      const code = newCode();
      const { data, error } = await db.from("rooms").insert({ code, game: "durak", host: pid, stake, players: [pid] }).select("*").single();
      if (!error) return out(await roomOut(data, pid));
    }
    return out({ error: "server" });
  }
  if (a === "invites") {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { data } = await db.from("rooms").select("code,host,stake,players,game").contains("invited", [pid]).eq("status", "wait").gt("updated_at", since).limit(5);
    const list = [];
    for (const r of data || []) {
      if (r.players.includes(pid)) continue;
      const [h] = await roomPlayers([r.host]);
      list.push({ code: r.code, game: r.game, stake: r.stake, count: r.players.length, host: h ? h.nick : "?" });
    }
    return out({ list });
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const room = await getRoom(body.code);
    if (!room) return out({ error: "no_room" });
    const inRoom = room.players.includes(pid);
    let patch: any = null;

    if (a === "room_get") {
      if (!inRoom) return out({ error: "not_in_room" });
      if (room.status === "play" && room.state && DK.timeout(room.state, TURN_MS)) {
        const st = room.state;
        let toPay = settle(room, st);
        patch = { state: st, status: st.over ? "done" : "play", _pay: toPay };
      } else {
        if (Number(body.ver) === room.ver) return out({ same: true, ver: room.ver, turnLeft: room.state && !room.state.over ? Math.max(0, Math.round((TURN_MS - (Date.now() - room.state.turnAt)) / 1000)) : 0 });
        return out(await roomOut(room, pid));
      }
    } else if (a === "room_join") {
      if (inRoom) return out(await roomOut(room, pid));
      if (room.status !== "wait") return out({ error: "started" });
      if (room.players.length >= room.maxp) return out({ error: "full" });
      patch = { players: [...room.players, pid], invited: room.invited.filter((x: number) => x !== pid) };
    } else if (a === "room_invite") {
      if (!inRoom) return out({ error: "not_in_room" });
      const fid = Number(body.fid);
      const { data: ex } = await db.from("players").select("pid").eq("pid", fid).maybeSingle();
      if (!ex) return out({ error: "no_player" });
      if (room.players.includes(fid)) return out({ error: "already" });
      patch = { invited: [...new Set([...room.invited, fid])] };
    } else if (a === "room_leave") {
      if (!inRoom) return out({ ok: true });
      if (room.status === "play") return out({ error: "playing" });
      const players = room.players.filter((x: number) => x !== pid);
      if (!players.length) { await db.from("rooms").delete().eq("code", room.code); return out({ ok: true }); }
      patch = { players, host: room.host === pid ? players[0] : room.host, status: "wait", state: null };
    } else if (a === "room_start") {
      if (room.host !== pid) return out({ error: "not_host" });
      if (room.status === "play") return out({ error: "playing" });
      if (room.players.length < 2) return out({ error: "few" });
      const ps = await roomPlayers(room.players);
      const need = room.stake * (room.players.length - 1);
      const poor = ps.find((p: any) => p.balance < need);
      if (poor) return out({ error: "poor", nick: poor.nick, need });
      patch = { status: "play", state: DK.init(room.players.length, room.stake) };
    } else if (a === "room_act") {
      if (!inRoom || room.status !== "play") return out({ error: "not_playing" });
      const st = room.state;
      const err = DK.act(st, room.players.indexOf(pid), String(body.a), body.card);
      if (err) return out({ error: "move", msg: err });
      const toPay = settle(room, st);
      patch = { state: st, status: st.over ? "done" : "play", _pay: toPay };
    } else return out({ error: "unknown_action" }, 400);

    const doPay = patch._pay; delete patch._pay;
    const saved = await saveRoom(room, patch);
    if (saved) { if (doPay) await pay(saved); return out(await roomOut(saved, pid)); }
    // кто-то успел изменить комнату — пробуем ещё раз
  }
  return out({ error: "busy" });
}

// ---------- обработка запросов ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return out("ok");
  if (req.method !== "POST") return out({ error: "method" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return out({ error: "bad_json" }, 400); }

  try {
    const user = await tgUser(body.initData);
    if (!user || !user.id) return out({ error: "auth" }, 401);

    let { data: me } = await db.from("players").select("*").eq("tg_id", user.id).maybeSingle();
    if (!me) me = await createPlayer(user);
    const pid: number = me.pid;
    const a = String(body.action || "");

    if (a === "login") {
      const ph = okPhoto(user.photo_url);
      const upd: any = { seen_at: new Date().toISOString(), photo: ph };
      if (ph && !me.photo && me.avatar !== "tg") upd.avatar = "tg";   // первый раз узнали фото — ставим его
      Object.assign(me, upd);
      await db.from("players").update(upd).eq("pid", pid);
      return out({ me: { ...pub(me), last_bonus: me.last_bonus }, friends: await friendsOf(pid) });
    }

    if (a === "delta") {
      let d = Math.trunc(Number(body.d) || 0);
      d = Math.max(-1_000_000_000, Math.min(MAX_STEP, d));
      const { data: bal, error } = await db.rpc("apply_delta", { p_pid: pid, p_delta: d, p_cap: HOUR_CAP });
      if (error) throw error;
      return out({ balance: bal });
    }

    if (a === "stat") {
      const game = GAMES.includes(body.game) ? body.game : "poker";
      await db.rpc("add_stat", { p_pid: pid, p_game: game, p_won: !!body.won });
      return out({ ok: true });
    }

    if (a === "bonus") {
      const { data: bal } = await db.rpc("take_bonus", { p_pid: pid, p_amount: BONUS });
      if (bal === null) return out({ error: "early", last_bonus: me.last_bonus });
      return out({ balance: bal, bonus: BONUS, last_bonus: new Date().toISOString() });
    }

    if (a === "nick") {
      const nick = String(body.nick || "").trim().replace(/\s+/g, " ");
      if (!NICK_RE.test(nick)) return out({ error: "bad_nick" });
      if (!(await nickFree(nick, pid))) return out({ error: "taken" });
      const { error } = await db.from("players").update({ nick }).eq("pid", pid);
      if (error) return out({ error: "taken" });
      return out({ nick });
    }

    if (a === "avatar") {
      const seed = String(body.seed || "");
      if (!/^p\d{1,2}$/.test(seed) && !(seed === "tg" && me.photo)) return out({ error: "bad_avatar" });
      await db.from("players").update({ avatar: seed, avatar_f: !!body.f }).eq("pid", pid);
      return out({ ok: true });
    }

    if (a === "search") {
      const q = String(body.q || "").trim().slice(0, 20);
      if (!q) return out({ list: [] });
      let rows: any[] = [];
      if (/^\d{6}$/.test(q)) {
        const { data } = await db.from("players").select(PUB).eq("pid", Number(q));
        rows = data || [];
      }
      if (q.length >= 2) {
        const { data } = await db.from("players").select(PUB)
          .ilike("nick", "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%").order("wins", { ascending: false }).limit(15);
        for (const r of data || []) if (!rows.some((x) => x.pid === r.pid)) rows.push(r);
      }
      return out({ list: rows.filter((r) => r.pid !== pid).slice(0, 15).map(pub) });
    }

    if (a === "friend_add" || a === "friend_del") {
      const fid = Number(body.fid);
      if (!fid || fid === pid) return out({ error: "bad_friend" });
      if (a === "friend_add") {
        const { data: ex } = await db.from("players").select("pid").eq("pid", fid).maybeSingle();
        if (!ex) return out({ error: "no_player" });
        await db.from("friends").upsert({ pid, fid });
      } else {
        await db.from("friends").delete().eq("pid", pid).eq("fid", fid);
      }
      return out({ friends: await friendsOf(pid) });
    }

    if (a === "ping") {
      await db.from("players").update({ seen_at: new Date().toISOString() }).eq("pid", pid);
      const { count } = await db.from("players").select("pid", { count: "exact", head: true }).gt("seen_at", new Date(Date.now() - ONLINE_MS).toISOString());
      return out({ online: count || 1 });
    }

    if (a === "friends") return out({ friends: await friendsOf(pid) });

    if (a.startsWith("room_") || a === "invites") return await roomAction(a, body, me);

    if (a === "top") {
      const col = body.by === "c" ? "balance" : "wins";
      const { data } = await db.from("players").select(PUB).order(col, { ascending: false }).limit(50);
      const { count } = await db.from("players").select("pid", { count: "exact", head: true }).gt(col, me[col]);
      const { count: onl } = await db.from("players").select("pid", { count: "exact", head: true }).gt("seen_at", new Date(Date.now() - ONLINE_MS).toISOString());
      return out({ list: (data || []).map(pub), myRank: (count || 0) + 1, online: onl || 1 });
    }

    if (a === "profile") {
      const { data } = await db.from("players").select(PUB).eq("pid", Number(body.pid)).maybeSingle();
      if (!data) return out({ error: "no_player" });
      const { count } = await db.from("players").select("pid", { count: "exact", head: true }).gt("wins", data.wins);
      const { data: fr } = await db.from("friends").select("fid").eq("pid", pid).eq("fid", data.pid).maybeSingle();
      return out({ player: pub(data), rank: (count || 0) + 1, friend: !!fr });
    }

    return out({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(e);
    return out({ error: "server" }, 500);
  }
});
