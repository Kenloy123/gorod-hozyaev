// КОЗЫРЬ: сервер (Supabase Edge Function с именем "api").
// Вставить целиком в редактор функции и нажать Deploy.
// Нужен секрет TG_BOT_TOKEN (токен бота из BotFather) — вставляется в Supabase, никому не отправлять.
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
const PUB = "pid,nick,avatar,avatar_f,wins,games,balance,by_game";
const fav = (by: Record<string, number>) => {
  const e = Object.entries(by || {}).sort((a, b) => b[1] - a[1])[0];
  return e ? e[0] : null;
};
const pub = (r: any) => r && ({ pid: r.pid, nick: r.nick, avatar: r.avatar, avatar_f: r.avatar_f, wins: r.wins, games: r.games, balance: r.balance, fav: fav(r.by_game) });
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
      .insert({ pid, tg_id: user.id, nick, balance: START_BALANCE })
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
  return (data || []).map(pub);
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
      await db.from("players").update({ seen_at: new Date().toISOString() }).eq("pid", pid);
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
      if (!/^p\d{1,2}$/.test(seed)) return out({ error: "bad_avatar" });
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

    if (a === "friends") return out({ friends: await friendsOf(pid) });

    if (a === "top") {
      const col = body.by === "c" ? "balance" : "wins";
      const { data } = await db.from("players").select(PUB).order(col, { ascending: false }).limit(50);
      const { count } = await db.from("players").select("pid", { count: "exact", head: true }).gt(col, me[col]);
      return out({ list: (data || []).map(pub), myRank: (count || 0) + 1 });
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
