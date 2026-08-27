const db = require('./db');

const MIN_PLAYERS = 2;
const MIN_BLANKS = 10;
const TURN_TIMEOUT_MS = 15000;

const AVATARS = {
  default: { title: 'Стандартная Рей', required: 0 },
  glasses: { title: 'Очки крутые', required: 10 },
  card:    { title: 'Карточка-рей', required: 100 },
};

function now() { return Date.now(); }

function ensureUser(user) {
  db.prepare(`
    INSERT INTO users (user_id, name, avatar) VALUES (?, ?, 'default')
    ON CONFLICT(user_id) DO UPDATE SET name=excluded.name
  `).run(user.id, user.name);
}

function countFinishedGames(userId) {
  return db.prepare(`
    SELECT COUNT(*) c FROM players p JOIN battles b ON b.id = p.battle_id
    WHERE p.user_id = ? AND b.status = 'finished'
  `).get(userId).c;
}

function getUserAvatar(userId) {
  const row = db.prepare('SELECT avatar FROM users WHERE user_id=?').get(userId);
  return row ? row.avatar : 'default';
}

function setAvatar(user, avatarKey) {
  const meta = AVATARS[avatarKey];
  if (!meta) throw new Error('Такого аксессуара не существует.');
  if (meta.required > 0 && countFinishedGames(user.id) < meta.required) {
    throw new Error(`Сыграй ${meta.required} игр, чтобы получить приз!`);
  }
  ensureUser(user);
  db.prepare('UPDATE users SET avatar=? WHERE user_id=?').run(avatarKey, user.id);
  return { avatar: avatarKey };
}

function setTurnWithTarget(battleId, shooterUserId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  let pending = battle.pending_anomalies ? JSON.parse(battle.pending_anomalies) : [];
  let currentAnomaly = null;
  let executionerTargets = null;

  if (pending.length > 0) {
    currentAnomaly = pending.shift();
    db.prepare('UPDATE battles SET pending_anomalies=? WHERE id=?').run(JSON.stringify(pending), battleId);
    
    const shooter = db.prepare('SELECT name FROM players WHERE battle_id=? AND user_id=?').get(battleId, shooterUserId);
    if (currentAnomaly === 'madness') {
      addLog(battleId, `🌀 АНОМАЛИЯ: БЕЗУМИЕ! ${shooter.name} теряет контроль. Твой выбор ничего не решает.`, 'anomaly');
    } else if (currentAnomaly === 'executioner') {
      const alive = db.prepare('SELECT * FROM players WHERE battle_id=? AND alive=1 AND user_id!=?').all(battleId, shooterUserId);
      const shuffled = shuffle(alive);
      const targets = shuffled.slice(0, 5).map(p => p.user_id);
      executionerTargets = JSON.stringify(targets);
      const targetNames = shuffled.slice(0, 5).map(p => p.name).join(', ');
      addLog(battleId, `🌀 АНОМАЛИЯ: ВЫБОР ПАЛАЧА! ${shooter.name} выбирает одну из 5 жертв: ${targetNames}`, 'anomaly');
    }
  }

  const alive = db.prepare('SELECT * FROM players WHERE battle_id=? AND alive=1').all(battleId);
  const others = alive.filter(p => String(p.user_id) !== String(shooterUserId));
  const target = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : null;
  const targetUserId = target ? target.user_id : null;

  db.prepare(`
    UPDATE battles SET turn_user_id=?, turn_started_at=?, target_user_id=?, current_anomaly=?, executioner_targets=? WHERE id=?
  `).run(shooterUserId, now(), targetUserId, currentAnomaly, executionerTargets, battleId);

  return targetUserId;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function addLog(battleId, text, cls = '') {
  db.prepare('INSERT INTO logs (battle_id, text, cls, created_at) VALUES (?,?,?,?)')
    .run(battleId, text, cls, now());
}

function validateCreateInput({ prize, minutes, maxPlayers, winnersCount, blanksCount, anomalyMadness, anomalyExecutioner }) {
  if (!prize || !String(prize).trim()) return 'Укажи приз.';
  if (!Number.isFinite(minutes) || minutes < 1) return 'Минимум 1 минута до старта.';
  if (!Number.isFinite(maxPlayers) || maxPlayers < MIN_PLAYERS) return `Минимум ${MIN_PLAYERS} игрока.`;
  if (!Number.isFinite(winnersCount) || winnersCount < 1 || winnersCount >= maxPlayers)
    return 'Победителей должно быть меньше, чем макс. игроков.';
  if (!Number.isFinite(blanksCount) || blanksCount < MIN_BLANKS) return `Минимум ${MIN_BLANKS} холостых патронов.`;
  return null;
}

function createBattle(user, input) {
  const err = validateCreateInput(input);
  if (err) throw new Error(err);
  const endsAt = now() + input.minutes * 60000;
  
  const pending = [];
  if (input.anomalyMadness) pending.push('madness');
  if (input.anomalyExecutioner) pending.push('executioner');

  const info = db.prepare(`
    INSERT INTO battles (prize, minutes, max_players, winners_count, blanks_count, status,
      created_by, created_by_name, ends_at, created_at, anomaly_madness, anomaly_executioner, pending_anomalies)
    VALUES (?,?,?,?,?, 'lobby', ?,?,?,?, ?, ?, ?)
  `).run(input.prize.trim(), input.minutes, input.maxPlayers, input.winnersCount, input.blanksCount,
    user.id, user.name, endsAt, now(),
    input.anomalyMadness ? 1 : 0,
    input.anomalyExecutioner ? 1 : 0,
    JSON.stringify(pending)
  );
  const battleId = info.lastInsertRowid;
  ensureUser(user);
  db.prepare('INSERT INTO players (battle_id, user_id, name, join_order) VALUES (?,?,?,0)')
    .run(battleId, user.id, user.name);
  addLog(battleId, `${user.name} создаёт битву и занимает место за столом.`, 'sys');
  return getBattle(battleId);
}

function joinBattle(user, battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) throw new Error('Битва не найдена.');
  if (battle.status !== 'lobby') throw new Error('В эту битву уже нельзя войти.');
  const already = db.prepare('SELECT * FROM players WHERE battle_id=? AND user_id=?').get(battleId, user.id);
  if (already) return getBattle(battleId);
  const count = db.prepare('SELECT COUNT(*) c FROM players WHERE battle_id=?').get(battleId).c;
  if (count >= battle.max_players) throw new Error('Свободных мест не осталось.');
  ensureUser(user);
  db.prepare('INSERT INTO players (battle_id, user_id, name, join_order) VALUES (?,?,?,?)')
    .run(battleId, user.id, user.name, count);
  addLog(battleId, `${user.name} садится за стол.`, 'sys');
  if (count + 1 >= battle.max_players) startBattle(battleId);
  return getBattle(battleId);
}

function startBattle(battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle || battle.status !== 'lobby') return;
  const players = db.prepare('SELECT * FROM players WHERE battle_id=? ORDER BY join_order').all(battleId);
  if (players.length < MIN_PLAYERS) {
    db.prepare("UPDATE battles SET status='cancelled' WHERE id=?").run(battleId);
    addLog(battleId, 'Недостаточно игроков — битва отменена.', 'sys');
    return;
  }
  const live = players.length;
  const blanks = battle.blanks_count;
  const chamber = shuffle(Array(live).fill('live').concat(Array(blanks).fill('blank')));
  const starter = pick(players);
  
  const others = players.filter(p => String(p.user_id) !== String(starter.user_id));
  const target = others.length > 0 ? pick(others) : null;
  const targetUserId = target ? target.user_id : null;

  let pending = battle.pending_anomalies ? JSON.parse(battle.pending_anomalies) : [];
  let currentAnomaly = null;
  let executionerTargets = null;

  if (pending.length > 0) {
    currentAnomaly = pending.shift();
    if (currentAnomaly === 'madness') {
      addLog(battleId, `🌀 АНОМАЛИЯ: БЕЗУМИЕ! ${starter.name} теряет контроль. Твой выбор ничего не решает.`, 'anomaly');
    } else if (currentAnomaly === 'executioner') {
      const alive = players.filter(p => String(p.user_id) !== String(starter.user_id));
      const shuffled = shuffle(alive);
      const targets = shuffled.slice(0, 5).map(p => p.user_id);
      executionerTargets = JSON.stringify(targets);
      const targetNames = shuffled.slice(0, 5).map(p => p.name).join(', ');
      addLog(battleId, `🌀 АНОМАЛИЯ: ВЫБОР ПАЛАЧА! ${starter.name} выбирает одну из 5 жертв: ${targetNames}`, 'anomaly');
    }
  }

  db.prepare(`
    UPDATE battles SET status='playing', chamber=?, turn_user_id=?, target_user_id=?, turn_started_at=?, remaining_place=?, pending_anomalies=?, current_anomaly=?, executioner_targets=? WHERE id=?
  `).run(JSON.stringify(chamber), starter.user_id, targetUserId, now(), players.length, JSON.stringify(pending), currentAnomaly, executionerTargets, battleId);
  
  addLog(battleId, `Барабан заряжен: ${live} боевых / ${blanks} холостых.`, 'sys');
  addLog(battleId, `Право стрелять получает ${starter.name}.`, 'sys');
}

function resolveExpiredLobbies() {
  const expired = db.prepare("SELECT id FROM battles WHERE status='lobby' AND ends_at<=?").all(now());
  for (const row of expired) startBattle(row.id);
}

function getAlive(battleId) {
  return db.prepare('SELECT * FROM players WHERE battle_id=? AND alive=1').all(battleId);
}

function eliminate(battleId, userId, remainingPlace) {
  db.prepare('UPDATE players SET alive=0, place=? WHERE battle_id=? AND user_id=?')
    .run(remainingPlace, battleId, userId);
}

function drawRound(battle) {
  const chamber = JSON.parse(battle.chamber);
  const round = chamber.shift();
  db.prepare('UPDATE battles SET chamber=? WHERE id=?').run(JSON.stringify(chamber), battle.id);
  return round;
}

function finishIfOneLeft(battleId) {
  const alive = getAlive(battleId);
  if (alive.length <= 1) {
    if (alive.length === 1) db.prepare('UPDATE players SET place=1 WHERE battle_id=? AND user_id=?')
      .run(battleId, alive[0].user_id);
    db.prepare("UPDATE battles SET status='finished', turn_user_id=NULL, target_user_id=NULL, current_anomaly=NULL, executioner_targets=NULL WHERE id=?").run(battleId);
    addLog(battleId, 'Бой завершён.', 'sys');
    return true;
  }
  return false;
}

function nextRandomShooter(battleId) {
  if (finishIfOneLeft(battleId)) return;
  const alive = getAlive(battleId);
  const next = pick(alive);
  setTurnWithTarget(battleId, next.user_id);
  addLog(battleId, `Право стрелять переходит к ${next.name}.`, 'sys');
}

function checkTurnTimeouts() {
  const cutoff = now() - TURN_TIMEOUT_MS;
  const stuck = db.prepare(`
    SELECT id, turn_user_id FROM battles
    WHERE status='playing' AND turn_user_id IS NOT NULL AND turn_started_at IS NOT NULL AND turn_started_at <= ?
  `).all(cutoff);
  for (const battle of stuck) {
    const shooter = db.prepare('SELECT * FROM players WHERE battle_id=? AND user_id=? AND alive=1')
      .get(battle.id, battle.turn_user_id);
    if (!shooter) continue;
    const seconds = Math.round(TURN_TIMEOUT_MS / 1000);
    addLog(battle.id, `${shooter.name} не успел выстрелить за ${seconds} секунд — умер.`, 'hit');
    const fresh = db.prepare('SELECT remaining_place FROM battles WHERE id=?').get(battle.id).remaining_place;
    eliminate(battle.id, shooter.user_id, fresh);
    db.prepare('UPDATE battles SET remaining_place=? WHERE id=?').run(fresh - 1, battle.id);
    nextRandomShooter(battle.id);
  }
}

function assertMyTurn(battle, user) {
  if (battle.status !== 'playing') throw new Error('Бой сейчас не идёт.');
  if (String(battle.turn_user_id) !== String(user.id)) throw new Error('Сейчас не твой ход.');
}

function resolveShot(battleId, shooterUserId, targetUserId, shooterName, targetName) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  const round = drawRound(battle);
  
  if (String(shooterUserId) === String(targetUserId)) {
    if (round === 'blank') {
      addLog(battleId, `${shooterName} стреляет в себя — холостой. Патрон передаётся снова ${shooterName}.`);
      db.prepare('UPDATE battles SET turn_started_at=? WHERE id=?').run(now(), battleId);
    } else {
      addLog(battleId, `${shooterName} стреляет в себя — боевой. ${shooterName} выбывает.`, 'hit');
      const fresh = db.prepare('SELECT remaining_place FROM battles WHERE id=?').get(battleId).remaining_place;
      eliminate(battleId, shooterUserId, fresh);
      db.prepare('UPDATE battles SET remaining_place=? WHERE id=?').run(fresh - 1, battleId);
      nextRandomShooter(battleId);
    }
  } else {
    if (round === 'blank') {
      addLog(battleId, `${shooterName} стреляет в ${targetName} — холостой. Право стрелять переходит к ${targetName}.`);
      setTurnWithTarget(battleId, targetUserId);
    } else {
      addLog(battleId, `${shooterName} стреляет в ${targetName} — боевой. ${targetName} выбывает.`, 'hit');
      const fresh = db.prepare('SELECT remaining_place FROM battles WHERE id=?').get(battleId).remaining_place;
      eliminate(battleId, targetUserId, fresh);
      db.prepare('UPDATE battles SET remaining_place=? WHERE id=?').run(fresh - 1, battleId);
      nextRandomShooter(battleId);
    }
  }
}

function shootSelf(user, battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) throw new Error('Битва не найдена.');
  assertMyTurn(battle, user);
  if (battle.current_anomaly) throw new Error('Сейчас активна аномалия, используй специальное действие.');
  const shooter = db.prepare('SELECT * FROM players WHERE battle_id=? AND user_id=?').get(battleId, user.id);
  resolveShot(battleId, user.id, user.id, shooter.name, shooter.name);
  return getBattle(battleId);
}

function shootOther(user, battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) throw new Error('Битва не найдена.');
  assertMyTurn(battle, user);
  if (battle.current_anomaly) throw new Error('Сейчас активна аномалия, используй специальное действие.');
  const shooter = db.prepare('SELECT * FROM players WHERE battle_id=? AND user_id=?').get(battleId, user.id);
  const others = getAlive(battleId).filter(p => String(p.user_id) !== String(user.id));
  if (others.length === 0) { finishIfOneLeft(battleId); return getBattle(battleId); }
  
  let target = others.find(p => String(p.user_id) === String(battle.target_user_id));
  if (!target) target = pick(others);
  
  resolveShot(battleId, user.id, target.user_id, shooter.name, target.name);
  return getBattle(battleId);
}

function shootMadness(user, battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) throw new Error('Битва не найдена.');
  assertMyTurn(battle, user);
  if (battle.current_anomaly !== 'madness') throw new Error('Сейчас не аномалия БЕЗУМИЕ.');

  const shooter = db.prepare('SELECT * FROM players WHERE battle_id=? AND user_id=?').get(battleId, user.id);
  const alive = getAlive(battleId);
  const others = alive.filter(p => String(p.user_id) !== String(user.id));
  
  const shootSelfChoice = Math.random() < 0.5;
  
  if (shootSelfChoice || others.length === 0) {
    addLog(battleId, `🌀 БЕЗУМИЕ: ${shooter.name} случайно направляет оружие на себя!`, 'anomaly');
    resolveShot(battleId, user.id, user.id, shooter.name, shooter.name);
  } else {
    const target = pick(others);
    addLog(battleId, `🌀 БЕЗУМИЕ: ${shooter.name} случайно направляет оружие на ${target.name}!`, 'anomaly');
    resolveShot(battleId, user.id, target.user_id, shooter.name, target.name);
  }
  
  db.prepare('UPDATE battles SET current_anomaly=NULL, executioner_targets=NULL WHERE id=?').run(battleId);
  return getBattle(battleId);
}

function executeTarget(user, battleId, targetUserId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) throw new Error('Битва не найдена.');
  assertMyTurn(battle, user);
  if (battle.current_anomaly !== 'executioner') throw new Error('Сейчас не аномалия ВЫБОР ПАЛАЧА.');
  
  const targets = JSON.parse(battle.executioner_targets || '[]');
  if (!targets.includes(String(targetUserId))) {
    throw new Error('Этой цели нет в списке.');
  }
  
  const shooter = db.prepare('SELECT * FROM players WHERE battle_id=? AND user_id=?').get(battleId, user.id);
  const target = db.prepare('SELECT * FROM players WHERE battle_id=? AND user_id=?').get(battleId, targetUserId);
  
  addLog(battleId, `🌀 ВЫБОР ПАЛАЧА: ${shooter.name} мгновенно убивает ${target.name}!`, 'hit');
  const fresh = db.prepare('SELECT remaining_place FROM battles WHERE id=?').get(battleId).remaining_place;
  eliminate(battleId, targetUserId, fresh);
  db.prepare('UPDATE battles SET remaining_place=? WHERE id=?').run(fresh - 1, battleId);
  
  db.prepare('UPDATE battles SET current_anomaly=NULL, executioner_targets=NULL WHERE id=?').run(battleId);
  
  nextRandomShooter(battleId);
  return getBattle(battleId);
}

function getBattle(battleId) {
  const battle = db.prepare('SELECT * FROM battles WHERE id=?').get(battleId);
  if (!battle) return null;
  const players = db.prepare(`
    SELECT p.user_id, p.name, p.alive, p.place, COALESCE(u.avatar,'default') as avatar
    FROM players p LEFT JOIN users u ON u.user_id = p.user_id
    WHERE p.battle_id=? ORDER BY p.join_order
  `).all(battleId);
  const logs = db.prepare('SELECT text, cls FROM logs WHERE battle_id=? ORDER BY id ASC').all(battleId);
  const chamber = battle.chamber ? JSON.parse(battle.chamber) : [];
  
  let executionerTargets = [];
  if (battle.current_anomaly === 'executioner' && battle.executioner_targets) {
    const targetIds = JSON.parse(battle.executioner_targets);
    executionerTargets = players.filter(p => targetIds.includes(String(p.user_id))).map(p => ({ user_id: p.user_id, name: p.name }));
  }

  return {
    id: battle.id,
    prize: battle.prize,
    minutes: battle.minutes,
    maxPlayers: battle.max_players,
    winnersCount: battle.winners_count,
    blanksCount: battle.blanks_count,
    status: battle.status,
    createdBy: battle.created_by,
    createdByName: battle.created_by_name,
    turnUserId: battle.turn_user_id,
    targetUserId: battle.target_user_id,
    turnStartedAt: battle.turn_started_at,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    endsAt: battle.ends_at,
    liveLeft: chamber.filter(c => c === 'live').length,
    blankLeft: chamber.filter(c => c === 'blank').length,
    players,
    log: logs,
    currentAnomaly: battle.current_anomaly,
    executionerTargets,
    anomalyMadness: battle.anomaly_madness,
    anomalyExecutioner: battle.anomaly_executioner,
  };
}

function listBattles() {
  const rows = db.prepare("SELECT id, status FROM battles ORDER BY id DESC LIMIT 100").all();
  return rows.map(r => getBattle(r.id));
}

function getProfile(user) {
  const rows = db.prepare(`
    SELECT b.id, b.prize, b.winners_count, p.place
    FROM players p JOIN battles b ON b.id = p.battle_id
    WHERE p.user_id = ? AND b.status = 'finished'
    ORDER BY b.id DESC
  `).all(user.id);
  const wins = rows.filter(r => r.place <= r.winners_count).length;
  const total = rows.length;
  const achievements = Object.entries(AVATARS)
    .filter(([key, meta]) => meta.required > 0)
    .map(([key, meta]) => ({
      id: key, image: key, title: meta.title, required: meta.required, unlocked: total >= meta.required,
    }));
  return {
    userId: user.id,
    name: user.name,
    avatar: getUserAvatar(user.id),
    wins,
    total,
    winRate: total ? Math.round((wins / total) * 100) : 0,
    history: rows.map(r => ({ prize: r.prize, place: r.place, win: r.place <= r.winners_count })),
    achievements,
  };
}

module.exports = {
  MIN_PLAYERS, MIN_BLANKS, AVATARS,
  createBattle, joinBattle, resolveExpiredLobbies, checkTurnTimeouts,
  shootSelf, shootOther, shootMadness, executeTarget,
  getBattle, listBattles, getProfile, setAvatar,
};
