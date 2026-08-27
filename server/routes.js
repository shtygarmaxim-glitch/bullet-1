const express = require('express');
const game = require('./game');
const admin = require('./admin');
const auth = require('./auth');

module.exports = function createRoutes(app) {
  const router = express.Router();

  // Middleware: достаём пользователя из Telegram initData
  router.use((req, res, next) => {
    try {
      req.user = auth.getUserFromInitData(req.headers['x-telegram-init-data']);
    } catch (e) {
      // Для локальной разработки без Telegram — тестовый пользователь
      if (process.env.ALLOW_DEV_FALLBACK === '1') {
        req.user = { id: 'dev-user', name: 'Тест-пилот' };
      } else {
        return res.status(401).json({ error: 'Неверная подпись Telegram' });
      }
    }
    next();
  });

  // === Битвы ===
  router.get('/battles', (req, res) => {
    try {
      res.json(game.listBattles());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/battles', (req, res) => {
    try {
      const battle = game.createBattle(req.user, req.body);
      res.json(battle);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/battles/:id/join', (req, res) => {
    try {
      const battle = game.joinBattle(req.user, parseInt(req.params.id));
      res.json(battle);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/battles/:id/shoot-self', (req, res) => {
    try {
      const battle = game.shootSelf(req.user, parseInt(req.params.id));
      res.json(battle);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/battles/:id/shoot-other', (req, res) => {
    try {
      const battle = game.shootOther(req.user, parseInt(req.params.id));
      res.json(battle);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // === Профиль ===
  router.get('/me', (req, res) => {
    try {
      const profile = game.getProfile(req.user);
      profile.isOwner = admin.isOwner(req.user);
      profile.canCreate = admin.isOwner(req.user) || admin.isAllowed(req.user);
      res.json(profile);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // === Аватар ===
  router.post('/avatar', (req, res) => {
    try {
      const result = game.setAvatar(req.user, req.body.avatar);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // === Админка ===
  router.get('/admin/allowed', (req, res) => {
    try {
      if (!admin.isOwner(req.user)) return res.status(403).json({ error: 'Доступ запрещён' });
      res.json(admin.getAllowed());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/admin/allowed', (req, res) => {
    try {
      if (!admin.isOwner(req.user)) return res.status(403).json({ error: 'Доступ запрещён' });
      const list = admin.addAllowed(req.body.identifier);
      res.json(list);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/admin/allowed/:identifier', (req, res) => {
    try {
      if (!admin.isOwner(req.user)) return res.status(403).json({ error: 'Доступ запрещён' });
      const list = admin.removeAllowed(req.params.identifier);
      res.json(list);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.use('/api', router);
};
