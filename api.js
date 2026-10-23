'use strict';
/** api.js — port of api.php. Every action keeps its PHP name and response shape. */
const express = require('express');
const mongoose = require('mongoose');

module.exports = (core) => {
  const { M, S, I, clean, stripTags, fmtDate, find, one, insert, bcrypt, uploadFile, upload, fileOf, csrfOk, escapeRx, byteLen,
    isLimited, hit, clearHits, resetCounters, logout } = core;
  const router = express.Router();

  const WAIT_MSG = 'অনেকবার ভুল চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।';
  const ok = (extra = {}) => ({ status: 'success', ...extra });
  const err = (message, extra = {}) => ({ status: 'error', message, ...extra });

  // Batch helpers (replace the SQL sub-selects)
  const countBy = async (Model, field, ids, extra = {}) => {
    if (!ids.length) return new Map();
    const rows = await Model.aggregate([{ $match: { [field]: { $in: ids }, ...extra } }, { $group: { _id: '$' + field, c: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [r._id, r.c]));
  };
  const usersById = async (ids, fields = 'id name profile_pic role team_id') => {
    const rows = ids.length ? await M.User.find({ id: { $in: [...new Set(ids)] } }).select(fields + ' -_id').lean() : [];
    return new Map(rows.map((u) => [u.id, u]));
  };
  const teamNames = async (ids) => {
    const rows = ids.length ? await M.Team.find({ id: { $in: [...new Set(ids)] } }).select('id team_name -_id').lean() : [];
    return new Map(rows.map((t) => [t.id, t.team_name]));
  };
  const isLeaderOf = (uid, teamId) => (teamId > 0 ? M.Team.exists({ id: teamId, leader_id: uid }) : null);
  const stamp = (rows) => rows.map((r) => ({ ...r, created_at: fmtDate(r.created_at) }));
  const text = (v, max) => { const t = S(v).trim(); return t.length > max ? null : t; };

  const A = {
    /* 1. FEED & POSTS */
    async load_feed(c) {
      const scope = S(c.b.scope) || 'global';
      const search = S(c.b.search).slice(0, 100);
      const profileRaw = S(c.b.profile_id);
      const filter = {};

      if (profileRaw && profileRaw !== '0') {
        const pid = I(profileRaw);
        filter.user_id = pid;
        // own profile shows everything (as in PHP); someone else's profile only shows what the viewer may see
        if (pid !== c.uid && c.role !== 'prince') filter.team_id = { $in: [0, c.teamId] };
      } else {
        if (scope === 'team') {
          if (!c.teamId) return { status: 'error', data: [], message: 'No team assigned' };
          filter.team_id = c.teamId;
        } else filter.team_id = 0;
        if (search) {
          const rx = new RegExp(escapeRx(search), 'i');
          const ids = (await M.User.find({ name: rx }).select('id -_id').lean()).map((u) => u.id);
          filter.$or = [{ content: rx }, { user_id: { $in: ids } }];
        }
      }

      const posts = await find(M.Post, filter, { created_at: -1, id: -1 }, 50);
      const users = await usersById(posts.map((p) => p.user_id));
      const live = posts.filter((p) => users.has(p.user_id));
      const pids = live.map((p) => p.id);
      const uids = [...new Set(live.map((p) => p.user_id))];
      const [likes, comments, leaders, names, mine] = await Promise.all([
        countBy(M.Like, 'post_id', pids), countBy(M.Comment, 'post_id', pids), countBy(M.Team, 'leader_id', uids),
        teamNames([...users.values()].map((u) => u.team_id).filter(Boolean)),
        pids.length ? M.Like.find({ user_id: c.uid, post_id: { $in: pids } }).select('post_id -_id').lean() : [],
      ]);
      const mineSet = new Set(mine.map((l) => l.post_id));

      const posted = live.map((p) => {
        const u = users.get(p.user_id);
        return {
          type: 'post', id: p.id, user_id: p.user_id, content: p.content, image: p.image, created_at: fmtDate(p.created_at),
          name: u.name, profile_pic: u.profile_pic, role: u.role, team_name: names.get(u.team_id) ?? null,
          is_leader: leaders.get(p.user_id) || 0, like_count: likes.get(p.id) || 0, is_liked: mineSet.has(p.id) ? 1 : 0, comment_count: comments.get(p.id) || 0,
        };
      });

      let feed = posted;
      if (scope === 'global' && !(profileRaw && profileRaw !== '0')) {
        const ads = (await find(M.Ad, { type: 'native', status: 'active' })).map((a) => ({ ...a, type: 'ad' }));
        feed = []; let ai = 0;
        posted.forEach((p, i) => { feed.push(p); if ((i + 1) % 5 === 0 && ads.length) { feed.push(ads[ai]); ai = (ai + 1) % ads.length; } });
      }
      return ok({ data: clean(feed), my_id: c.uid });
    },

    async create_post(c) {
      const scope = S(c.b.scope) || 'global';
      const tid = scope === 'team' ? c.teamId : 0;
      const content = stripTags(S(c.b.content).trim());
      if (content.length > 10000) return err('Post too long');
      const img = await uploadFile(fileOf(c.req, 'image'));
      if (content || img) {
        await insert(M.Post, { user_id: c.uid, content, image: img, team_id: tid });
        await M.User.updateOne({ id: c.uid }, { $inc: { power_level: 5 } });
        return ok();
      }
      return err('Empty post');
    },

    /* 3. CHAT */
    async load_chat(c) {
      let tid = 0;
      if (S(c.b.type) === 'team') {
        if (!c.teamId) return { status: 'error', data: [], message: 'Join a team first' };
        tid = c.teamId;
      }
      const rows = (await find(M.Chat, { team_id: tid }, { created_at: -1, id: -1 }, 200)).reverse(); // newest 200, oldest first
      const users = await usersById(rows.map((r) => r.user_id));
      const data = rows.filter((r) => users.has(r.user_id)).map((r) => ({ ...r, created_at: fmtDate(r.created_at), name: users.get(r.user_id).name, profile_pic: users.get(r.user_id).profile_pic }));
      return ok({ data: clean(data), uid: c.uid });
    },
    async send_chat(c) {
      const msg = S(c.b.message).trim();
      const type = S(c.b.type);
      const tid = type === 'team' ? c.teamId : 0;
      if (type === 'team' && tid === 0) return null;
      if (msg && msg.length <= 2000) { await insert(M.Chat, { user_id: c.uid, team_id: tid, message: msg }); return ok(); }
      return null;
    },

    /* 4. LOAD TEAM DATA */
    async load_team_data(c) {
      if (!c.teamId) return { status: 'no_team' };
      const team = await one(M.Team, { id: c.teamId });
      if (!team) return { status: 'no_team' };
      const [notices, missions, members] = await Promise.all([
        find(M.Notice, { team_id: c.teamId }, { created_at: -1, id: -1 }),
        find(M.Mission, { team_id: c.teamId, status: 'approved' }, { created_at: -1, id: -1 }),
        M.User.find({ team_id: c.teamId }).select('id name profile_pic power_level role address -_id').sort({ power_level: -1, id: 1 }).lean(),
      ]);
      return ok({
        team: clean({ ...team, created_at: fmtDate(team.created_at) }),
        is_leader: team.leader_id === c.uid,
        notices: clean(stamp(notices)), missions: clean(stamp(missions)),
        members: clean(members.map((m) => ({ ...m, tname: team.team_name }))),
      });
    },

    /* 5. SEARCH MEMBERS */
    async search_members(c) {
      const rx = new RegExp(escapeRx(S(c.b.query).slice(0, 100)), 'i');
      const rows = await M.User.find({ name: rx, status: { $ne: 'banned' } }).select('id name profile_pic power_level team_id address -_id').sort({ power_level: -1, id: 1 }).limit(50).lean();
      const names = await teamNames(rows.map((u) => u.team_id).filter(Boolean));
      return ok({ data: clean(rows.map((u) => ({ ...u, tname: names.get(u.team_id) ?? null }))) });
    },

    /* 6. DELETE POST & LIKE & COMMENT */
    async delete_post(c) {
      const pid = I(c.b.post_id);
      const post = await one(M.Post, { id: pid });
      if ((post && post.user_id === c.uid) || c.role === 'prince') {
        await Promise.all([M.Post.deleteOne({ id: pid }), M.Like.deleteMany({ post_id: pid }), M.Comment.deleteMany({ post_id: pid })]);
        return ok();
      }
      return err('Unauthorized');
    },
    async like_post(c) {
      const pid = I(c.b.post_id);
      if (!(await M.Post.exists({ id: pid }))) return err('Post not found');
      let liked;
      const del = await M.Like.deleteOne({ user_id: c.uid, post_id: pid });
      if (del.deletedCount > 0) liked = false;
      else {
        try { await insert(M.Like, { user_id: c.uid, post_id: pid }); } catch (e) { if (e.code !== 11000) throw e; }
        liked = true;
      }
      return ok({ liked, count: await M.Like.countDocuments({ post_id: pid }) });
    },
    async comment_post(c) {
      const comment = S(c.b.comment).trim();
      if (!comment) return null;
      if (comment.length > 2000) return err('Comment too long');
      const pid = I(c.b.post_id);
      if (!(await M.Post.exists({ id: pid }))) return err('Post not found');
      await insert(M.Comment, { user_id: c.uid, post_id: pid, comment });
      return ok({ user: clean(c.me.name), comment: clean(comment), pic: c.me.profile_pic });
    },
    async load_comments(c) {
      const rows = await find(M.Comment, { post_id: I(c.b.post_id) }, { created_at: 1, id: 1 });
      const users = await usersById(rows.map((r) => r.user_id));
      return ok({ data: clean(rows.filter((r) => users.has(r.user_id)).map((r) => ({ ...r, created_at: fmtDate(r.created_at), name: users.get(r.user_id).name, profile_pic: users.get(r.user_id).profile_pic }))) });
    },

    /* 7. MISSIONS & LEADER ACTIONS */
    async load_missions(c) {
      const rows = await find(M.Mission, { status: 'approved', team_id: { $in: [0, c.teamId] } }, { created_at: -1, id: -1 });
      return ok({ missions: clean(stamp(rows)) });
    },
    async create_team_notice(c) {
      if (!(await isLeaderOf(c.uid, c.teamId))) return err('Only leaders');
      const title = text(c.b.title, 300); const message = text(c.b.message, 5000);
      if (!title || !message) return err('Title and message are required');
      await insert(M.Notice, { title, message, created_by: c.uid, team_id: c.teamId, status: 'approved' });
      return ok();
    },
    async create_team_mission(c) {
      if (!(await isLeaderOf(c.uid, c.teamId))) return err('Only leaders');
      const title = text(c.b.title, 300); const description = text(c.b.desc, 5000);
      if (!title || !description) return err('Title and description are required');
      const img = await uploadFile(fileOf(c.req, 'image'));
      await insert(M.Mission, { title, description, points_reward: Math.max(0, Math.min(I(c.b.points), 1000000)), image: img, team_id: c.teamId, created_by: c.uid, status: 'pending' });
      return ok({ message: 'Sent for approval' });
    },

    /* 8. POLLS */
    async load_polls(c) {
      const polls = await find(M.Poll, {}, { created_at: -1, id: -1 });
      const pollIds = polls.map((p) => p.id);
      const [opts, myVotes] = await Promise.all([
        pollIds.length ? find(M.Option, { poll_id: { $in: pollIds } }, { id: 1 }) : [],
        pollIds.length ? find(M.Vote, { poll_id: { $in: pollIds }, user_id: c.uid }) : [],
      ]);
      const votes = await countBy(M.Vote, 'option_id', opts.map((o) => o.id));
      const mine = new Map(myVotes.map((v) => [v.poll_id, v.option_id]));
      const data = polls.map((p) => {
        const options = opts.filter((o) => o.poll_id === p.id).map((o) => ({ id: o.id, option_text: o.option_text, votes: votes.get(o.id) || 0 }));
        return { ...p, created_at: fmtDate(p.created_at), options, total_votes: options.reduce((s, o) => s + o.votes, 0), my_vote: mine.has(p.id) ? mine.get(p.id) : false };
      });
      return ok({ data: clean(data) });
    },
    async submit_vote(c) {
      const pid = I(c.b.poll_id); const oid = I(c.b.option_id);
      if (!(await M.Option.exists({ id: oid, poll_id: pid }))) return err('Invalid option');
      if (await M.Vote.exists({ poll_id: pid, user_id: c.uid })) return err('Already voted');
      try { await insert(M.Vote, { poll_id: pid, option_id: oid, user_id: c.uid }); } catch (e) { if (e.code === 11000) return err('Already voted'); throw e; }
      return ok();
    },

    /* 9. PROFILE & SETTINGS */
    async change_password(c) {
      const oldPass = S(c.b.old_password); const newPass = S(c.b.new_password);
      if (byteLen(newPass) < 10) return err('নতুন পাসওয়ার্ড কমপক্ষে ১০ অক্ষরের হতে হবে');
      const key = 'pw:' + c.uid;
      if (await isLimited(key, 5)) return err(WAIT_MSG);
      const u = await one(M.User, { id: c.uid });
      if (await bcrypt.compare(oldPass, u.password)) {
        await M.User.updateOne({ id: c.uid }, { $set: { password: await bcrypt.hash(newPass, 10) } });
        await clearHits(key);
        return ok({ message: 'পাসওয়ার্ড পরিবর্তন সফল হয়েছে!' });
      }
      await hit(key, 900);
      return err('পুরাতন পাসওয়ার্ড ভুল!');
    },
    async upload_profile_pic(c) {
      const p = await uploadFile(fileOf(c.req, 'pic'));
      if (!p) return err('Invalid file');
      await M.User.updateOne({ id: c.uid }, { $set: { profile_pic: p } });
      return ok();
    },
    async submit_id_card(c) {
      const p = await uploadFile(fileOf(c.req, 'id_card'));
      if (!p) return err('Invalid file');
      await M.User.updateOne({ id: c.uid }, { $set: { id_card_image: p, id_card_status: 'pending' } });
      return ok();
    },

    /* 10. UTILS */
    async load_blood_reqs() {
      const rows = await find(M.Blood, {}, { created_at: -1, id: -1 }, 20);
      const users = await usersById(rows.map((r) => r.user_id));
      return ok({ data: clean(rows.filter((r) => users.has(r.user_id)).map((r) => ({ ...r, created_at: fmtDate(r.created_at), name: users.get(r.user_id).name, profile_pic: users.get(r.user_id).profile_pic }))) });
    },
    async request_blood(c) {
      const blood_group = text(c.b.group, 10); const location = text(c.b.location, 300); const contact = text(c.b.contact, 50);
      if (!blood_group || !location || !contact) return err('সব তথ্য দিন');
      await insert(M.Blood, { user_id: c.uid, blood_group, location, details: '', contact });
      return ok();
    },
    async load_notices() {
      const rows = await find(M.Notice, { status: 'approved', team_id: 0 }, { created_at: -1, id: -1 });
      const users = await usersById(rows.map((r) => r.created_by));
      return ok({ data: clean(rows.filter((r) => users.has(r.created_by)).map((r) => ({ ...r, created_at: fmtDate(r.created_at), name: users.get(r.created_by).name }))) });
    },
    async load_rules() { return ok({ data: clean(await find(M.Rule, {}, { id: 1 })) }); },

    /* 11. DATABASE BACKUP & RESTORE (ADMIN ONLY) — JSON instead of SQL */
    async backup_database(c) {
      if (c.role !== 'prince') return err('Unauthorized');
      const collections = {};
      for (const [name, Model] of Object.entries(COLLS)) collections[name] = await find(Model, {});
      const body = JSON.stringify({ format: 'saiyan-mongodb-backup', version: 1, generated: new Date().toISOString(), collections });
      const stampName = fmtDate(new Date()).slice(0, 16).replace(' ', '_').replace(':', '-');
      c.res.set({ 'Content-Description': 'File Transfer', 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename=backup_${stampName}.json` });
      c.res.send(body);
      return undefined;
    },
    async restore_database(c) {
      if (c.role !== 'prince') return err('Unauthorized');
      const file = fileOf(c.req, 'backup_file');
      if (!file) return err('File upload failed');
      let data;
      try { data = JSON.parse(file.buffer.toString('utf8')); } catch (_) { return err('Restore Failed: invalid backup file'); }
      if (!data || data.format !== 'saiyan-mongodb-backup' || !data.collections || typeof data.collections !== 'object') return err('Restore Failed: not a Saiyan backup file');
      const names = Object.keys(data.collections).filter((n) => Object.hasOwn(COLLS, n) && Array.isArray(data.collections[n]));
      if (!names.length) return err('Restore Failed: backup contains no data');
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          for (const n of names) {
            const docs = data.collections[n].filter((d) => d && typeof d === 'object' && !Array.isArray(d)).map(({ _id, __v, ...rest }) => rest);
            await COLLS[n].deleteMany({}, { session });
            if (docs.length) await COLLS[n].insertMany(docs, { session });
          }
        });
        await resetCounters();
        return ok({ message: 'Database Restored Successfully!' });
      } catch (e) {
        console.error('Restore failed:', e);
        return err('Restore Failed: ' + e.message);
      } finally { await session.endSession(); }
    },
  };

  const COLLS = {
    users: M.User, teams: M.Team, community_posts: M.Post, post_likes: M.Like, post_comments: M.Comment, chats: M.Chat, notices: M.Notice,
    missions: M.Mission, polls: M.Poll, poll_options: M.Option, poll_votes: M.Vote, events: M.Event, rules: M.Rule, ads: M.Ad, blood_requests: M.Blood,
  };

  // 1. AUTHENTICATION CHECK → then uploads → 2. CSRF → refresh user → dispatch
  router.all('/api.php', (req, res, next) => (req.sess.uid ? next() : res.json(err('Login required'))), upload, async (req, res) => {
    if (req.method === 'POST' && !csrfOk(req)) return res.status(403).type('text/plain').send('Security Error: Invalid CSRF Token.');

    const me = await one(M.User, { id: req.sess.uid });
    if (!me || !(me.status === 'active' || me.status === 'approved')) {
      logout(req, res);
      return res.json(err(me ? 'Login required' : 'User not found'));
    }
    const b = req.body || {};
    const action = S(b.action);
    const fn = Object.hasOwn(A, action) ? A[action] : null;
    if (!fn) return res.json(err('Invalid action'));

    const out = await fn({ req, res, b, me, uid: me.id, role: me.role, teamId: me.team_id || 0 });
    if (out === undefined) return;         // handler already answered (file download)
    if (out === null) return res.end();    // PHP printed nothing
    res.json(out);
  });

  return router;
};
