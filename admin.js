'use strict';
/** admin.js — port of prince.php, the "PRINCE ADMIN" panel (served at /prince.php). Only users with role "prince". */
const express = require('express');

module.exports = (core) => {
  const { M, S, I, h, attrJson, find, one, insert, uploadFile, upload, fileOf, csrfOk, currentUser, logout } = core;
  const router = express.Router();

  const STATUSES = ['pending', 'approved', 'active', 'banned'];
  const text = (v, max) => { const t = S(v).trim(); return t.length > max ? '' : t; };

  /* ---------------------------------------------------------------- */
  /* ADMIN ACTIONS CONTROLLER                                          */
  /* ---------------------------------------------------------------- */
  // Each action returns [message, type]. Types: success | warning | danger
  const ACTIONS = {
    // --- 1. USER MANAGEMENT ---
    async update_full_user_profile({ b }) {
      const uid = I(b.user_id);
      const name = text(b.name, 200); const phone = text(b.phone, 30); const address = S(b.address).trim().slice(0, 1000);
      const teamId = I(b.team_id); // empty / "0" → 0
      const status = S(b.status); const pl = I(b.power_level);
      if (!name || !phone) return ['নাম ও ফোন নম্বর দিতে হবে!', 'danger'];
      if (!STATUSES.includes(status)) return ['Invalid status', 'danger'];
      if (teamId && !(await M.Team.exists({ id: teamId }))) return ['Team not found!', 'danger'];
      try {
        const r = await M.User.updateOne({ id: uid }, { $set: { name, phone, address, team_id: teamId, status, power_level: pl } });
        if (!r.matchedCount) return ['User ID not found!', 'danger'];
      } catch (e) { if (e.code === 11000) return ['এই ফোন নম্বরটি অন্য একজন ইউজারের আছে!', 'danger']; throw e; }
      return ['ইউজারের তথ্য এবং টিম সফলভাবে আপডেট হয়েছে!', 'success'];
    },
    async verify_id({ b }) {
      const stat = S(b.status); const uid = I(b.uid);
      if (['approved', 'rejected'].includes(stat)) {
        // only pending cards can be decided (prevents repeated +100 awards)
        const r = await M.User.updateOne({ id: uid, id_card_status: 'pending' }, { $set: { id_card_status: stat } });
        if (r.matchedCount && stat === 'approved') await M.User.updateOne({ id: uid }, { $inc: { power_level: 100 } });
        return ['আইডি ভেরিফিকেশন সম্পন্ন হয়েছে!', 'success'];
      }
      return null;
    },

    // --- 2. TEAM MANAGEMENT ---
    async create_team({ b }) {
      const tName = text(b.team_name, 200);
      if (tName) { await insert(M.Team, { team_name: tName }); return ['নতুন টিম তৈরি হয়েছে!', 'success']; }
      return null;
    },
    async delete_team({ b }) {
      const tid = I(b.team_id);
      await M.User.updateMany({ team_id: tid }, { $set: { team_id: 0 } }); // members go back to Global
      await M.Team.deleteOne({ id: tid });
      return ['টিম ডিলিট করা হয়েছে!', 'warning'];
    },
    async assign_leader({ b }) {
      const tid = I(b.team_id); const uid = I(b.user_id);
      const user = await one(M.User, { id: uid });
      if (!user) return ['User ID not found!', 'danger'];
      if (!(await M.Team.exists({ id: tid }))) return ['Team not found!', 'danger'];
      await M.Team.updateOne({ id: tid }, { $set: { leader_id: uid } });
      await M.User.updateOne({ id: uid }, { $set: user.role === 'prince' ? { team_id: tid } : { role: 'admin', team_id: tid } }); // never demote an admin
      return ['লিডার অ্যাসাইন করা হয়েছে!', 'success'];
    },

    // --- 3. MISSIONS & EVENTS ---
    async create_admin_mission({ b, req, uid }) {
      const title = text(b.title, 300); const description = text(b.desc, 5000);
      if (!title || !description) return ['শিরোনাম ও বিবরণ দিতে হবে!', 'danger'];
      const img = await uploadFile(fileOf(req, 'image'));
      await insert(M.Mission, { title, description, points_reward: Math.max(0, Math.min(I(b.points), 1000000)), image: img, team_id: I(b.team_id), created_by: uid, status: 'approved' });
      return ['নতুন মিশন তৈরি হয়েছে!', 'success'];
    },
    async approve_mission({ b }) { await M.Mission.updateOne({ id: I(b.id) }, { $set: { status: 'approved' } }); return ['মিশন এপ্রুভ করা হয়েছে!', 'success']; },
    async delete_mission({ b }) { await M.Mission.deleteOne({ id: I(b.id) }); return ['মিশন ডিলিট করা হয়েছে!', 'success']; },
    async create_event({ b }) {
      const title = text(b.title, 300); const date = S(b.date).trim(); const description = S(b.desc).trim().slice(0, 5000);
      if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return ['ইভেন্টের নাম ও সঠিক তারিখ দিন!', 'danger'];
      await insert(M.Event, { title, event_date: date, description });
      return ['নতুন ইভেন্ট যুক্ত হয়েছে!', 'success'];
    },
    async delete_event({ b }) { await M.Event.deleteOne({ id: I(b.id) }); return ['ইভেন্ট রিমুভ করা হয়েছে!', 'success']; },

    // --- 4. CONTENT & SETTINGS ---
    async delete_post({ b }) {
      const pid = I(b.post_id);
      await Promise.all([M.Post.deleteOne({ id: pid }), M.Like.deleteMany({ post_id: pid }), M.Comment.deleteMany({ post_id: pid })]);
      return ['পোস্ট রিমুভ করা হয়েছে!', 'success'];
    },
    async clear_global_chat() { await M.Chat.deleteMany({ team_id: 0 }); return ['গ্লোবাল চ্যাট হিস্ট্রি ক্লিয়ার করা হয়েছে!', 'warning']; },
    async delete_chat_msg({ b }) { await M.Chat.deleteOne({ id: I(b.chat_id) }); return ['চ্যাট মেসেজ ডিলিট করা হয়েছে!', 'success']; },

    // --- POLLS ---
    async create_poll({ b, uid }) {
      const title = text(b.title, 500);
      const raw = b['options[]'] ?? b.options;
      const opts = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((o) => typeof o === 'string').map((o) => o.trim().slice(0, 300)).filter(Boolean);
      if (!title || opts.length < 2) return ['পোলের শিরোনাম এবং কমপক্ষে ২টি অপশন দিন!', 'danger'];
      const pid = await insert(M.Poll, { title, created_by: uid });
      for (const o of opts) await insert(M.Option, { poll_id: pid, option_text: o });
      return ['পোল পাবলিশ হয়েছে!', 'success'];
    },
    async delete_poll({ b }) {
      const id = I(b.id);
      const optIds = (await find(M.Option, { poll_id: id })).map((o) => o.id);
      await Promise.all([M.Poll.deleteOne({ id }), M.Option.deleteMany({ poll_id: id }), M.Vote.deleteMany({ poll_id: id }), optIds.length ? M.Vote.deleteMany({ option_id: { $in: optIds } }) : null]);
      return ['পোল ডিলিট করা হয়েছে!', 'success'];
    },

    // --- EXTRAS (Notices, Rules, Ads) ---
    async add_rule({ b }) {
      const content = text(b.content, 2000);
      if (!content) return null;
      await insert(M.Rule, { content });
      return ['রুলস আপডেট হয়েছে!', 'success'];
    },
    async delete_rule({ b }) { await M.Rule.deleteOne({ id: I(b.id) }); return ['রুলস ডিলিট করা হয়েছে!', 'success']; },
    async create_notice({ b, uid }) {
      const title = text(b.title, 300); const message = text(b.message, 5000);
      if (!title || !message) return ['নোটিশের শিরোনাম ও বার্তা দিন!', 'danger'];
      await insert(M.Notice, { title, message, created_by: uid, team_id: I(b.team_id), status: 'approved' });
      return ['নোটিশ পাঠানো হয়েছে!', 'success'];
    },
    async delete_notice({ b }) { await M.Notice.deleteOne({ id: I(b.id) }); return ['নোটিশ ডিলিট করা হয়েছে!', 'success']; },
    async add_ad({ b, req }) {
      const img = await uploadFile(fileOf(req, 'image'));
      const title = text(b.title, 300); const link = S(b.link).trim();
      let linkOk = false; try { linkOk = ['http:', 'https:'].includes(new URL(link).protocol) && link.length <= 2000; } catch (_) { /* invalid */ }
      if (!img) return ['ছবি আপলোড ব্যর্থ হয়েছে!', 'danger'];
      if (!title || !linkOk) return ['বিজ্ঞাপনের শিরোনাম ও সঠিক http/https লিংক দিন!', 'danger'];
      await insert(M.Ad, { title, image: img, link, type: 'native', status: 'active' });
      return ['বিজ্ঞাপন যুক্ত হয়েছে!', 'success'];
    },
    async delete_ad({ b }) { await M.Ad.deleteOne({ id: I(b.id) }); return ['বিজ্ঞাপন রিমুভ করা হয়েছে!', 'success']; },
    async delete_blood({ b }) { await M.Blood.deleteOne({ id: I(b.id) }); return ['রক্তের আবেদন ডিলিট করা হয়েছে!', 'success']; },
  };

  /* ---------------------------------------------------------------- */
  /* Page                                                              */
  /* ---------------------------------------------------------------- */
  const CSS = `
        body { font-family: 'Hind Siliguri', sans-serif; background: #f0f2f5; overflow-x: hidden; }
        .sidebar { width: 260px; height: 100vh; background: #2c3e50; position: fixed; overflow-y: auto; z-index: 1000; transition: 0.3s; }
        .sidebar-header { padding: 20px; background: #1a252f; color: #fff; text-align: center; border-bottom: 1px solid #34495e; }
        .nav-link { color: #ecf0f1; padding: 12px 20px; font-size: 15px; border-left: 4px solid transparent; transition: 0.2s; }
        .nav-link:hover, .nav-link.active { background: #34495e; border-left-color: #3498db; }
        .nav-link i { width: 25px; text-align: center; margin-right: 10px; }
        .main-content { margin-left: 260px; padding: 20px; width: calc(100% - 260px); }
        .card { border: none; box-shadow: 0 2px 5px rgba(0,0,0,0.05); border-radius: 8px; margin-bottom: 20px; }
        .badge-count { background: #e74c3c; color: white; padding: 2px 6px; border-radius: 10px; font-size: 10px; float: right; margin-top: 5px; }
        .stat-card { border-radius: 10px; padding: 20px; color: white; position: relative; overflow: hidden; }
        @media(max-width: 768px) {
            .sidebar { margin-left: -260px; }
            .sidebar.active { margin-left: 0; }
            .main-content { margin-left: 0; width: 100%; }
        }
    `;

  const GLOBAL_JS = `
function filterTable(input) {
    let filter = input.value.toUpperCase();
    let rows = document.getElementById("userTableBody").getElementsByTagName("tr");
    for (let i=0; i<rows.length; i++) {
        let txt = rows[i].textContent || rows[i].innerText;
        rows[i].style.display = txt.toUpperCase().indexOf(filter) > -1 ? "" : "none";
    }
}

// Function to open Edit Modal and fill data
function openEditModal(user) {
    document.getElementById('edit_uid').value = user.id;
    document.getElementById('edit_name').value = user.name;
    document.getElementById('edit_phone').value = user.phone;
    document.getElementById('edit_address').value = user.address;
    
    // Team ID Logic
    let tid = user.team_id;
    document.getElementById('edit_team').value = (tid === null || tid === undefined) ? 0 : tid;
    
    document.getElementById('edit_status').value = user.status;
    document.getElementById('edit_pl').value = user.power_level;
    
    var modal = new bootstrap.Modal(document.getElementById('editUserModal'));
    modal.show();
}
`;

  const RESTORE_JS = `
        function restoreDB() {
            if(!confirm("আপনি কি নিশ্চিত? এটি বর্তমান ডাটাবেস মুছে ব্যাকআপ ফাইলটি বসাবে!")) return;
            
            let fd = new FormData(document.getElementById('restoreForm'));
            let btn = document.querySelector('#restoreForm button');
            let originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Restoring...';
            btn.disabled = true;

            fetch('api.php', {
                method: 'POST',
                body: fd
            })
            .then(res => res.json())
            .then(data => {
                alert(data.message);
                if(data.status === 'success') location.reload();
            })
            .catch(err => {
                alert('Restore Failed! Check console.');
                console.error(err);
            })
            .finally(() => {
                btn.innerHTML = originalText;
                btn.disabled = false;
            });
        }
`;

  async function render(csrf, tab, msg, msgType) {
    const CI = `<input type="hidden" name="csrf_token" value="${csrf}">`;
    // small form builder: a POST form with csrf + action + hidden fields
    const F = (action, fields, inner, attrs = '') =>
      `<form method="POST" ${attrs}>${CI}<input type="hidden" name="action" value="${action}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${h(v)}">`).join('')}${inner}</form>`;

    const teams = await find(M.Team, {}, { id: 1 });
    const teamName = new Map(teams.map((t) => [t.id, t.team_name]));
    const teamOpts = teams.map((t) => `<option value="${t.id}">${h(t.team_name)}</option>`).join('');

    const [users, posts, teamsCount, pendingMissions, pendingIds] = await Promise.all([
      M.User.countDocuments(), M.Post.countDocuments(), M.Team.countDocuments(),
      M.Mission.countDocuments({ status: 'pending' }), M.User.countDocuments({ id_card_status: 'pending' }),
    ]);
    const stats = { users, posts, teams: teamsCount, pending_missions: pendingMissions, pending_ids: pendingIds };

    let out = '';

    // 1. DASHBOARD
    if (tab === 'dashboard') {
      out += `
        <h4>ওভারভিউ</h4>
        <div class="row g-3 mt-2">
            <div class="col-md-3 col-6"><div class="stat-card bg-primary"><h3>${stats.users}</h3><small>Total Users</small></div></div>
            <div class="col-md-3 col-6"><div class="stat-card bg-success"><h3>${stats.teams}</h3><small>Total Teams</small></div></div>
            <div class="col-md-3 col-6"><div class="stat-card bg-warning text-dark"><h3>${stats.pending_missions}</h3><small>Pending Missions</small></div></div>
            <div class="col-md-3 col-6"><div class="stat-card bg-danger"><h3>${stats.pending_ids}</h3><small>Pending IDs</small></div></div>
        </div>`;
    }

    // 2. USERS
    if (tab === 'users') {
      const all = await find(M.User, {}, { id: -1 });
      const pending = await find(M.User, { id_card_status: 'pending' });
      const rows = all.map((u) => {
        // password hash is never sent to the browser
        const jsonUser = attrJson({ id: u.id, name: u.name, phone: u.phone, address: u.address, team_id: u.team_id, status: u.status, power_level: u.power_level });
        return `
                            <tr>
                                <td>${h(u.name)}</td>
                                <td>${h(u.phone)}<br><small class="text-muted">${h(u.status)}</small></td>
                                <td>${h(teamName.get(u.team_id) ?? 'No Team')}</td>
                                <td>${h(u.power_level)}</td>
                                <td>
                                    <!-- Edit Button (Passes Data to JS Safely) -->
                                    <button class="btn btn-sm btn-primary" onclick='openEditModal(${jsonUser})'>
                                        <i class="fas fa-edit"></i> Edit
                                    </button>
                                </td>
                            </tr>`;
      }).join('');
      const cards = pending.map((pu) => `
                    <div class="col-md-4 mb-3">
                        <div class="card p-3">
                            <img src="${h(pu.id_card_image)}" class="w-100 mb-2 rounded" style="height:150px; object-fit:cover">
                            <strong>${h(pu.name)}</strong>
                            <div class="d-flex gap-2 mt-2">
                                ${F('verify_id', { uid: pu.id, status: 'approved' }, '<button class="btn btn-success btn-sm w-100">Approve</button>', 'class="w-50"')}
                                ${F('verify_id', { uid: pu.id, status: 'rejected' }, '<button class="btn btn-danger btn-sm w-100">Reject</button>', 'class="w-50"')}
                            </div>
                        </div>
                    </div>`).join('');
      out += `
        <ul class="nav nav-tabs mb-3"><li class="nav-item"><a class="nav-link active" data-bs-toggle="tab" href="#uList">List</a></li><li class="nav-item"><a class="nav-link text-danger" data-bs-toggle="tab" href="#uVerify">Verify ID (${stats.pending_ids})</a></li></ul>
        <div class="tab-content">
            <div class="tab-pane fade show active" id="uList">
                <input type="text" class="form-control mb-3" placeholder="মেম্বার খুঁজুন..." onkeyup="filterTable(this)">
                <div class="table-responsive bg-white rounded shadow-sm">
                    <table class="table table-hover mb-0">
                        <thead><tr><th>User</th><th>Info</th><th>Team</th><th>PL</th><th>Action</th></tr></thead>
                        <tbody id="userTableBody">${rows}
                        </tbody>
                    </table>
                </div>
            </div>
            
            <div class="tab-pane fade" id="uVerify">
                <div class="row">${cards}
                </div>
            </div>
        </div>

        <!-- EDIT USER MODAL -->
        <div class="modal fade" id="editUserModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Edit User Profile</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <form method="POST">
                            ${CI}
                            <input type="hidden" name="action" value="update_full_user_profile">
                            <input type="hidden" name="user_id" id="edit_uid">
                            
                            <label class="small text-muted">Name</label>
                            <input type="text" name="name" id="edit_name" class="form-control mb-2" required>

                            <label class="small text-muted">Phone</label>
                            <input type="text" name="phone" id="edit_phone" class="form-control mb-2" required>

                            <label class="small text-muted">Address</label>
                            <textarea name="address" id="edit_address" class="form-control mb-2"></textarea>
                            
                            <label class="small text-muted fw-bold text-primary">Assign Team</label>
                            <select name="team_id" id="edit_team" class="form-select mb-2 border-primary">
                                <option value="0">--- No Team (Global) ---</option>
                                ${teamOpts}
                            </select>

                            <div class="row">
                                <div class="col-6">
                                    <label class="small text-muted">Status</label>
                                    <select name="status" id="edit_status" class="form-select mb-2">
                                        <option value="pending">Pending</option>
                                        <option value="approved">Approved</option>
                                        <option value="active">Active</option>
                                        <option value="banned">Banned</option>
                                    </select>
                                </div>
                                <div class="col-6">
                                    <label class="small text-muted">Power Level</label>
                                    <input type="number" name="power_level" id="edit_pl" class="form-control mb-2">
                                </div>
                            </div>
                            
                            <button class="btn btn-primary w-100 mt-2 fw-bold">Update Profile</button>
                        </form>
                    </div>
                </div>
            </div>
        </div>`;
    }

    // 3. TEAMS
    if (tab === 'teams') {
      const leaderIds = teams.map((t) => t.leader_id).filter(Boolean);
      const leaders = new Map((leaderIds.length ? await M.User.find({ id: { $in: leaderIds } }).select('id name -_id').lean() : []).map((u) => [u.id, u.name]));
      const cards = teams.map((t) => `
            <div class="col-md-6 mb-3">
                <div class="card p-3 border-start border-4 border-info">
                    <div class="d-flex justify-content-between">
                        <div>
                            <h5 class="fw-bold m-0">${h(t.team_name)}</h5>
                            <small>Leader: ${h(leaders.get(t.leader_id) ?? 'None')}</small>
                        </div>
                        <div>
                            <button class="btn btn-sm btn-dark" onclick="setLeader(${t.id})">Leader</button>
                            ${F('delete_team', { team_id: t.id }, '<button class="btn btn-sm btn-danger">X</button>', `class="d-inline" onsubmit="return confirm('Delete Team?')"`)}
                        </div>
                    </div>
                </div>
            </div>`).join('');
      out += `
        <div class="card p-3 mb-3">
            <h6>নতুন টিম তৈরি করুন</h6>
            <form method="POST" class="d-flex gap-2">
                ${CI}
                <input type="hidden" name="action" value="create_team">
                <input class="form-control" name="team_name" placeholder="টিমের নাম..." required>
                <button class="btn btn-primary">Create</button>
            </form>
        </div>
        <div class="row">${cards}
        </div>
        <!-- Leader Modal -->
        <div class="modal fade" id="leaderModal"><div class="modal-dialog"><div class="modal-content"><div class="modal-body">
            <h5>Assign Leader</h5>
            <form method="POST">
                ${CI}
                <input type="hidden" name="action" value="assign_leader">
                <input type="hidden" name="team_id" id="lid_tid">
                <input class="form-control mb-2" name="user_id" placeholder="User ID" required>
                <button class="btn btn-success w-100">Assign</button>
            </form>
        </div></div></div></div>
        <script>function setLeader(id){document.getElementById('lid_tid').value=id; new bootstrap.Modal(document.getElementById('leaderModal')).show();}</script>`;
    }

    // 4. MISSIONS & EVENTS
    if (tab === 'missions') {
      const pending = await find(M.Mission, { status: 'pending' }, { id: 1 });
      const active = await find(M.Mission, { status: 'approved' }, { id: -1 });
      const events = await find(M.Event, {}, { id: 1 });
      const pendingHtml = pending.length ? `
                <div class="card p-3 bg-warning bg-opacity-10 border-warning border-start border-4 mb-3">
                    <h5 class="text-warning-emphasis">পেন্ডিং মিশন রিকোয়েস্ট (${pending.length})</h5>
                    <div class="row">${pending.map((pm) => `
                        <div class="col-md-6 mb-2">
                            <div class="bg-white p-2 rounded shadow-sm border">
                                <h6 class="fw-bold">${h(pm.title)}</h6>
                                <p class="small mb-1 text-muted">${h(pm.description)}</p>
                                <div class="badge bg-secondary mb-2">${h(teamName.get(pm.team_id) ?? 'Unknown Team')}</div>
                                <div class="d-flex gap-2">
                                    ${F('approve_mission', { id: pm.id }, '<button class="btn btn-sm btn-success w-100">Approve</button>', 'class="w-50"')}
                                    ${F('delete_mission', { id: pm.id }, '<button class="btn btn-sm btn-danger w-100">Reject</button>', 'class="w-50"')}
                                </div>
                            </div>
                        </div>`).join('')}
                    </div>
                </div>` : '';
      out += `
        <div class="row">
            <!-- Create Mission -->
            <div class="col-md-4">
                <div class="card p-3 border-primary border-top border-3">
                    <h5 class="text-primary"><i class="fas fa-plus-circle"></i> নতুন মিশন তৈরি</h5>
                    <form method="POST" enctype="multipart/form-data">
                        ${CI}
                        <input type="hidden" name="action" value="create_admin_mission">
                        <label class="small text-muted">শিরোনাম</label>
                        <input type="text" name="title" class="form-control form-control-sm mb-2" required>
                        <label class="small text-muted">বিবরণ</label>
                        <textarea name="desc" class="form-control form-control-sm mb-2" required></textarea>
                        <label class="small text-muted">পয়েন্ট</label>
                        <input type="number" name="points" class="form-control form-control-sm mb-2" value="50">
                        <label class="small text-muted">টিম (অপশনাল)</label>
                        <select name="team_id" class="form-select form-select-sm mb-2">
                            <option value="0">Global (All)</option>
                            ${teamOpts}
                        </select>
                        <label class="small text-muted">ছবি</label>
                        <input type="file" name="image" class="form-control form-control-sm mb-3">
                        <button class="btn btn-primary w-100 btn-sm">মিশন চালু করুন</button>
                    </form>
                </div>
                
                <!-- Create Event -->
                <div class="card p-3 border-info border-top border-3 mt-3">
                    <h5 class="text-info"><i class="fas fa-calendar-plus"></i> ইভেন্ট তৈরি</h5>
                    <form method="POST">
                        ${CI}
                        <input type="hidden" name="action" value="create_event">
                        <input name="title" class="form-control form-control-sm mb-2" placeholder="Event Name" required>
                        <textarea name="desc" class="form-control form-control-sm mb-2" placeholder="Details"></textarea>
                        <input type="date" name="date" class="form-control form-control-sm mb-2" required>
                        <button class="btn btn-info w-100 btn-sm text-white">সেভ ইভেন্ট</button>
                    </form>
                </div>
            </div>

            <!-- Approve & Manage Missions -->
            <div class="col-md-8">
                <!-- Pending Approvals -->${pendingHtml}

                <!-- Active Missions List -->
                <div class="card p-3">
                    <h5>এক্টিভ মিশনসমূহ</h5>
                    <div class="table-responsive">
                        <table class="table table-sm align-middle">
                            <thead class="table-light"><tr><th>Title</th><th>Team</th><th>Pts</th><th>Action</th></tr></thead>
                            <tbody>${active.map((am) => `
                                <tr>
                                    <td>${h(am.title)}</td>
                                    <td>${am.team_id === 0 ? '<span class="badge bg-success">Global</span>' : h(teamName.get(am.team_id) ?? '')}</td>
                                    <td>${h(am.points_reward)}</td>
                                    <td>
                                        ${F('delete_mission', { id: am.id }, '<button class="btn btn-sm btn-outline-danger py-0"><i class="fas fa-trash"></i></button>')}
                                    </td>
                                </tr>`).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
                
                <!-- Events List -->
                <div class="card p-3 mt-3">
                    <h5>ইভেন্ট তালিকা</h5>
                    <ul class="list-group">${events.map((ev) => `
                        <li class="list-group-item d-flex justify-content-between py-1">
                            <span>${h(ev.event_date)}: ${h(ev.title)}</span>
                            ${F('delete_event', { id: ev.id }, '<button class="btn btn-sm text-danger py-0">X</button>')}
                        </li>`).join('')}
                    </ul>
                </div>
            </div>
        </div>`;
    }

    // 5. POSTS & CHAT
    if (tab === 'posts') {
      const posts = await find(M.Post, {}, { created_at: -1, id: -1 }, 10);
      const chats = await find(M.Chat, {}, { created_at: -1, id: -1 }, 30);
      const ids = [...new Set([...posts.map((p) => p.user_id), ...chats.map((c) => c.user_id)])];
      const names = new Map((ids.length ? await M.User.find({ id: { $in: ids } }).select('id name -_id').lean() : []).map((u) => [u.id, u.name]));
      out += `
        <div class="row">
            <div class="col-md-7">
                <div class="card p-3">
                    <h5>রিসেন্ট পোস্ট</h5>${posts.filter((p) => names.has(p.user_id)).map((p) => `
                    <div class="border-bottom py-2 d-flex justify-content-between">
                        <div>
                            <strong>${h(names.get(p.user_id))}:</strong> <span class="text-muted">${h(Array.from(p.content || '').slice(0, 50).join(''))}...</span>
                        </div>
                        ${F('delete_post', { post_id: p.id }, '<button class="btn btn-sm btn-danger py-0">Del</button>')}
                    </div>`).join('')}
                </div>
            </div>
            <div class="col-md-5">
                <div class="card p-3 bg-light">
                    <div class="d-flex justify-content-between">
                        <h5>চ্যাট মনিটর</h5>
                        ${F('clear_global_chat', {}, '<button class="btn btn-sm btn-danger">Clear All</button>', `onsubmit="return confirm('Clear All?')"`)}
                    </div>
                    <div style="height:400px; overflow-y:auto">${chats.filter((c) => names.has(c.user_id)).map((c) => `
                        <div class="small border-bottom py-1">
                            <strong class="text-primary">${h(names.get(c.user_id))}:</strong> ${h(c.message)}
                            ${F('delete_chat_msg', { chat_id: c.id }, '<button class="btn btn-link text-danger p-0 text-decoration-none">x</button>', 'class="d-inline float-end"')}
                        </div>`).join('')}
                    </div>
                </div>
            </div>
        </div>`;
    }

    // 6. POLLS
    if (tab === 'polls') {
      const polls = await find(M.Poll, {}, { id: -1 });
      out += `
        <div class="card p-3">
            <h5>নতুন ভোটিং পোল</h5>
            <form method="POST">
                ${CI}
                <input type="hidden" name="action" value="create_poll">
                <input type="text" name="title" class="form-control mb-2" placeholder="Title..." required>
                <div class="row g-2 mb-2">
                    <div class="col-6"><input name="options[]" class="form-control form-control-sm" placeholder="Opt 1"></div>
                    <div class="col-6"><input name="options[]" class="form-control form-control-sm" placeholder="Opt 2"></div>
                </div>
                <button class="btn btn-primary btn-sm">Publish</button>
            </form>
        </div>${polls.map((pl) => `
        <div class="alert alert-secondary d-flex justify-content-between p-2">
            <span>${h(pl.title)}</span>
            ${F('delete_poll', { id: pl.id }, '<button class="btn btn-sm btn-danger py-0">X</button>')}
        </div>`).join('')}`;
    }

    // 7. SERVICES
    if (tab === 'services') {
      const blood = await find(M.Blood, {}, { id: -1 }, 10);
      const ads = await find(M.Ad, {}, { id: 1 });
      out += `
        <div class="row">
            <div class="col-md-6">
                <h5>রক্তের আবেদন</h5>${blood.map((b) => `
                <div class="card p-2 mb-2 border-danger border-start border-3 d-flex flex-row justify-content-between">
                    <span>${h(b.blood_group)} (${h(b.location)})</span>
                    ${F('delete_blood', { id: b.id }, '<button class="btn btn-sm text-danger">x</button>')}
                </div>`).join('')}
            </div>
            <div class="col-md-6">
                <h5>বিজ্ঞাপন (Ads)</h5>
                <form method="POST" enctype="multipart/form-data" class="card p-3">
                    ${CI}
                    <input type="hidden" name="action" value="add_ad">
                    <input name="title" class="form-control form-control-sm mb-1" placeholder="Title" required>
                    <input name="link" class="form-control form-control-sm mb-1" placeholder="http://..." required>
                    <input type="file" name="image" class="form-control form-control-sm mb-1" required>
                    <button class="btn btn-dark btn-sm w-100">Add Ad</button>
                </form>${ads.map((ad) => `
                <div class="d-flex justify-content-between align-items-center border-bottom py-1">
                    <small>${h(ad.title)}</small>
                    ${F('delete_ad', { id: ad.id }, '<button class="btn btn-sm text-danger">x</button>')}
                </div>`).join('')}
            </div>
        </div>`;
    }

    // 8. SETTINGS
    if (tab === 'settings') {
      const notices = await find(M.Notice, {}, { id: -1 }, 5);
      const rules = await find(M.Rule, {}, { id: 1 });
      out += `
        <div class="row">
            <!-- Backup & Restore Card -->
            <div class="col-12 mb-4">
                <div class="card p-4 border-dark border-2 shadow">
                    <h4 class="text-dark fw-bold mb-3"><i class="fas fa-database"></i> ডাটাবেস ব্যাকআপ & রিস্টোর</h4>
                    <div class="row g-3">
                        <div class="col-md-6">
                            <div class="p-3 bg-light rounded border">
                                <h6 class="fw-bold text-success">ব্যাকআপ ডাউনলোড করুন</h6>
                                <p class="small text-muted">সম্পূর্ণ ডাটাবেস .json ফাইল হিসেবে ডাউনলোড হবে। এটি নিরাপদ স্থানে সংরক্ষণ করুন।</p>
                                <form method="POST" action="api.php" target="_blank">
                                    ${CI}
                                    <input type="hidden" name="action" value="backup_database">
                                    <button class="btn btn-success w-100"><i class="fas fa-download"></i> Download Backup</button>
                                </form>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="p-3 bg-light rounded border">
                                <h6 class="fw-bold text-danger">রিস্টোর ডাটাবেস</h6>
                                <p class="small text-muted">সতর্কতা: এটি বর্তমানের সব ডাটা মুছে ফেলে ব্যাকআপ ফাইলটি সেট করবে।</p>
                                <form id="restoreForm">
                                    ${CI}
                                    <input type="hidden" name="action" value="restore_database">
                                    <input type="file" name="backup_file" class="form-control mb-2" accept=".json,application/json" required>
                                    <button type="button" onclick="restoreDB()" class="btn btn-danger w-100"><i class="fas fa-upload"></i> Restore Now</button>
                                </form>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Existing Notice Board & Rules -->
            <div class="col-md-6">
                <div class="card p-3">
                    <h5>নোটিশ বোর্ড</h5>
                    <form method="POST" class="mb-3">
                        ${CI}
                        <input type="hidden" name="action" value="create_notice">
                        <select name="team_id" class="form-select form-select-sm mb-2"><option value="0">Global</option>${teamOpts}</select>
                        <input name="title" class="form-control form-control-sm mb-2" placeholder="Title">
                        <textarea name="message" class="form-control form-control-sm mb-2" placeholder="Msg"></textarea>
                        <button class="btn btn-sm btn-primary w-100">Send</button>
                    </form>${notices.map((n) => `
                    <div class="d-flex justify-content-between border-bottom py-1 small">
                        <span>${h(n.title)}</span>
                        ${F('delete_notice', { id: n.id }, '<button class="btn btn-link text-danger p-0">x</button>')}
                    </div>`).join('')}
                </div>
            </div>
            <div class="col-md-6">
                <div class="card p-3">
                    <h5>রুলস</h5>
                    <form method="POST" class="d-flex gap-2 mb-2">
                        ${CI}
                        <input type="hidden" name="action" value="add_rule">
                        <input name="content" class="form-control form-control-sm">
                        <button class="btn btn-sm btn-success">+</button>
                    </form>
                    <ul class="list-group small">${rules.map((r) => `
                        <li class="list-group-item d-flex justify-content-between">
                            ${h(r.content)}
                            ${F('delete_rule', { id: r.id }, '<button class="btn btn-link text-danger p-0">x</button>')}
                        </li>`).join('')}
                    </ul>
                </div>
            </div>
        </div>

        <script>${RESTORE_JS}</script>`;
    }

    const T = (name) => (tab === name ? 'active' : '');
    return `<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prince Admin Panel</title>
    <!-- Bootstrap CSS -->
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <!-- Font Awesome -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <!-- Bengali Font -->
    <link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    
    <style>${CSS}</style>
</head>
<body>

<!-- Sidebar -->
<div class="sidebar" id="sidebar">
    <div class="sidebar-header">
        <h4 class="fw-bold m-0">PRINCE ADMIN</h4>
    </div>
    <nav class="nav flex-column mt-2">
        <a href="?tab=dashboard" class="nav-link ${T('dashboard')}"><i class="fas fa-home"></i> ড্যাশবোর্ড</a>
        <a href="?tab=users" class="nav-link ${T('users')}"><i class="fas fa-users"></i> ইউজার্স <span class="badge-count">${stats.pending_ids}</span></a>
        <a href="?tab=teams" class="nav-link ${T('teams')}"><i class="fas fa-shield-alt"></i> টিমস</a>
        <a href="?tab=missions" class="nav-link ${T('missions')}"><i class="fas fa-bullseye"></i> মিশন & ইভেন্ট <span class="badge-count">${stats.pending_missions}</span></a>
        <a href="?tab=posts" class="nav-link ${T('posts')}"><i class="fas fa-newspaper"></i> পোস্ট & চ্যাট</a>
        <a href="?tab=polls" class="nav-link ${T('polls')}"><i class="fas fa-poll"></i> ভোটিং</a>
        <a href="?tab=services" class="nav-link ${T('services')}"><i class="fas fa-heart"></i> সার্ভিসেস</a>
        <a href="?tab=settings" class="nav-link ${T('settings')}"><i class="fas fa-cog"></i> সেটিংস</a>
        <a href="index.php?logout=true" class="nav-link text-danger mt-4"><i class="fas fa-sign-out-alt"></i> লগ আউট</a>
    </nav>
</div>

<!-- Main Content -->
<div class="main-content">
    
    <button class="btn btn-dark d-md-none mb-3" onclick="document.getElementById('sidebar').classList.toggle('active')"><i class="fas fa-bars"></i></button>

    ${msg ? `<div class="alert alert-${msgType} alert-dismissible fade show">${h(msg)}<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>` : ''}
${out}

</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>${GLOBAL_JS}</script>
</body>
</html>`;
  }

  // Auth first (cheap), then upload parsing, then CSRF + action
  const gate = async (req, res, next) => {
    const me = await currentUser(req);
    if (!me || me.role !== 'prince') { if (req.sess.uid && !me) logout(req, res); return res.redirect('/index.php'); }
    req.admin = me;
    next();
  };

  router.all('/prince.php', gate, upload, async (req, res) => {
    let msg = ''; let msgType = 'success';
    if (req.method === 'POST') {
      if (!csrfOk(req)) return res.status(403).type('text/plain').send('Security Error: Invalid CSRF Token.');
      const b = req.body || {};
      const fn = Object.hasOwn(ACTIONS, S(b.action)) ? ACTIONS[S(b.action)] : null;
      if (fn) {
        try {
          const r = await fn({ b, req, uid: req.admin.id });
          if (r) [msg, msgType] = r;
        } catch (e) { console.error(e); msg = 'Error: অপারেশন সম্পন্ন করা যায়নি।'; msgType = 'danger'; }
      }
    }
    res.type('html').send(await render(req.sess.csrf, S(req.query.tab) || 'dashboard', msg, msgType));
  });

  return router;
};
