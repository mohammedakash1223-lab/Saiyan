'use strict';
/** team.js — port of team.php (served at /team.php). */
const express = require('express');

module.exports = (core) => {
  const { currentUser, logout, scriptBody } = core;
  const router = express.Router();

  const CSS = `
        body { background: #f0f2f5; font-family: 'Hind Siliguri', sans-serif; padding-bottom: 70px; }
        .team-header { background: linear-gradient(135deg, #008080, #005f5f); color: white; padding: 25px 15px; border-radius: 0 0 25px 25px; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.15); }
        
        /* Nav Pills Design */
        .nav-pills { background: white; padding: 5px; border-radius: 15px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); overflow-x: auto; flex-wrap: nowrap; }
        .nav-pills .nav-item { white-space: nowrap; }
        .nav-pills .nav-link { color: #555; border-radius: 10px; padding: 8px 15px; }
        .nav-pills .nav-link.active { background-color: #008080; color: white; }

        /* Card Designs */
        .member-card { background: white; padding: 10px; border-radius: 12px; margin-bottom: 8px; display: flex; align-items: center; gap: 10px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
        .notice-card { background: #e3f2fd; border-left: 5px solid #2196f3; border-radius: 8px; padding: 15px; margin-bottom: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .mission-card { background: white; border-left: 5px solid #4caf50; border-radius: 8px; padding: 15px; margin-bottom: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); position: relative; overflow: hidden; }
        
        /* Chat Styles */
        .chat-bubble { max-width: 80%; padding: 8px 12px; border-radius: 15px; margin-bottom: 8px; font-size: 0.9rem; }
        .chat-me { background: #008080; color: white; margin-left: auto; border-bottom-right-radius: 2px; }
        .chat-other { background: #e4e6eb; color: black; margin-right: auto; border-bottom-left-radius: 2px; }
        
        .bottom-nav { position: fixed; bottom: 0; width: 100%; background: white; border-top: 1px solid #ddd; display: flex; justify-content: space-around; padding: 10px 0; z-index: 1000; }
        .bottom-nav a { color: #666; font-size: 20px; }
        .active-nav { color: #008080 !important; }
    `;

  /* Browser-side code (sent as a classic script). */
  function clientTeam() {
    /* global $, CSRF_TOKEN */
    let teamChatInterval = null;

    $(document).ready(function() {
      loadTeamData();
    });

    function loadTeamData() {
      // Including CSRF Token in POST
      $.post('api.php', {action: 'load_team_data', csrf_token: CSRF_TOKEN}, function(res) {
        if(res.status === 'success') {
          let t = res.team;
          let leaderBtn = res.is_leader ? `<a href="leader.php" class="btn btn-warning btn-sm mt-2 fw-bold text-dark rounded-pill px-3 shadow-sm"><i class="fas fa-crown"></i> লিডার প্যানেল</a>` : '';

          let html = `
                    <div class="team-header">
                        <h2 class="fw-bold"><i class="fas fa-shield-alt"></i> ${t.team_name}</h2>
                        ${leaderBtn}
                    </div>
                    
                    <div class="container mt-3 pb-5">
                        <!-- Navigation Tabs -->
                        <ul class="nav nav-pills mb-3 justify-content-between" id="pills-tab">
                            <li class="nav-item"><button class="nav-link active" data-bs-toggle="pill" data-bs-target="#feed">ফিড</button></li>
                            <li class="nav-item"><button class="nav-link" data-bs-toggle="pill" data-bs-target="#chat" onclick="startTeamChat()">চ্যাট</button></li>
                            <li class="nav-item"><button class="nav-link" data-bs-toggle="pill" data-bs-target="#missions">মিশন</button></li>
                            <li class="nav-item"><button class="nav-link" data-bs-toggle="pill" data-bs-target="#notices">নোটিশ</button></li>
                            <li class="nav-item"><button class="nav-link" data-bs-toggle="pill" data-bs-target="#members">সদস্য</button></li>
                        </ul>
                        
                        <div class="tab-content">
                            <!-- 1. FEED -->
                            <div class="tab-pane fade show active" id="feed">
                                <div class="card p-3 mb-3 shadow-sm border-0 d-flex flex-row gap-2 align-items-center" onclick="$('#teamPostModal').modal('show')" style="border-radius:12px">
                                    <div class="bg-light rounded-pill px-3 py-2 flex-grow-1 text-muted">টিমের জন্য কিছু লিখুন...</div>
                                    <i class="fas fa-paper-plane text-success fs-4"></i>
                                </div>
                                <div id="teamFeedList">Loading...</div>
                            </div>

                            <!-- 2. TEAM CHAT -->
                            <div class="tab-pane fade" id="chat">
                                <div id="teamChatBox" class="d-flex flex-column pb-5" style="height:60vh; overflow-y:auto;"></div>
                                <div class="fixed-bottom bg-white p-2 border-top d-flex gap-2" style="bottom:50px; max-width:600px; margin:0 auto;">
                                    <input type="text" id="tMsgIn" class="form-control rounded-pill" placeholder="টিম মেসেজ...">
                                    <button class="btn btn-success rounded-circle" onclick="sendTeamMsg()"><i class="fas fa-paper-plane"></i></button>
                                </div>
                            </div>

                            <!-- 3. MISSIONS -->
                            <div class="tab-pane fade" id="missions">
                                ${res.missions.length ? '' : '<div class="text-center text-muted mt-4">কোনো মিশন নেই</div>'}
                                ${res.missions.map(m => `
                                    <div class="mission-card">
                                        <div class="d-flex justify-content-between">
                                            <h6 class="fw-bold text-success m-0">${m.title}</h6>
                                            <span class="badge bg-success">+${m.points_reward} PL</span>
                                        </div>
                                        <p class="small text-muted mt-1 mb-0">${m.description}</p>
                                        ${m.image ? `<img src="${m.image}" class="mt-2 rounded w-100" style="max-height:150px; object-fit:cover">` : ''}
                                    </div>
                                `).join('')}
                            </div>

                            <!-- 4. NOTICES -->
                            <div class="tab-pane fade" id="notices">
                                ${res.notices.length ? '' : '<div class="text-center text-muted mt-4">কোনো নোটিশ নেই</div>'}
                                ${res.notices.map(n => `
                                    <div class="notice-card">
                                        <h6 class="fw-bold text-primary mb-1"><i class="fas fa-bell"></i> ${n.title}</h6>
                                        <p class="mb-0 small text-dark">${n.message}</p>
                                        <small class="text-muted" style="font-size:10px">${n.created_at || ''}</small>
                                    </div>
                                `).join('')}
                            </div>

                            <!-- 5. MEMBERS -->
                            <div class="tab-pane fade" id="members">
                                <div class="text-muted small mb-2 ps-1">মোট সদস্য: ${res.members.length} জন</div>
                                ${res.members.map(m => `
                                    <div class="member-card">
                                        <img src="${m.profile_pic || 'https://via.placeholder.com/50'}" style="width:50px;height:50px;border-radius:50%;object-fit:cover;border:2px solid #ddd">
                                        <div class="flex-grow-1">
                                            <div class="fw-bold">${m.name} ${m.role==='leader'?'<i class="fas fa-crown text-warning"></i>':''}</div>
                                            <div class="small text-secondary"><i class="fas fa-map-marker-alt text-danger"></i> ${m.address || 'ঠিকানা নেই'}</div>
                                        </div>
                                        <span class="badge bg-primary rounded-pill">PL: ${m.power_level}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                `;
          $('#teamArea').html(html);
          loadTeamPosts();
        }
      }, 'json');
    }

    // Team Chat Logic
    function startTeamChat() {
      clearInterval(teamChatInterval);
      fetchTeamChat();
      teamChatInterval = setInterval(fetchTeamChat, 2000);
    }
    function fetchTeamChat() {
      $.post('api.php', {action: 'load_chat', type: 'team', csrf_token: CSRF_TOKEN}, function(res){
        let html = '';
        res.data.forEach(c => {
          let isMe = (c.user_id == res.uid);
          html += `
                <div class="d-flex flex-column ${isMe?'align-items-end':'align-items-start'}">
                    ${!isMe ? `<small class="ms-1 text-muted" style="font-size:10px">${c.name}</small>` : ''}
                    <div class="chat-bubble ${isMe?'chat-me':'chat-other'}">${c.message}</div>
                </div>`;
        });
        $('#teamChatBox').html(html);
      }, 'json');
    }
    function sendTeamMsg() {
      let m = $('#tMsgIn').val();
      if(!m) return;
      $('#tMsgIn').val('');
      $.post('api.php', {action: 'send_chat', type: 'team', message: m, csrf_token: CSRF_TOKEN}, function(){ fetchTeamChat(); });
    }

    // Feed Logic
    function loadTeamPosts() {
      $.post('api.php', {action: 'load_feed', scope: 'team', csrf_token: CSRF_TOKEN}, function(res){
        let html = '';
        if(!res.data || res.data.length === 0) {
          $('#teamFeedList').html('<div class="text-center text-muted mt-5">কোনো পোস্ট নেই</div>');
          return;
        }
        res.data.forEach(item => {
          html += `
                    <div class="card p-3 mb-2 shadow-sm border-0" style="border-radius:12px">
                        <div class="d-flex align-items-center mb-2">
                            <img src="${item.profile_pic || 'https://via.placeholder.com/35'}" style="width:35px;height:35px;border-radius:50%;margin-right:10px;object-fit:cover">
                            <div>
                                <div class="fw-bold small">${item.name}</div>
                                <small class="text-muted" style="font-size:10px">${item.created_at}</small>
                            </div>
                        </div>
                        <div class="mb-2" style="white-space:pre-wrap">${item.content}</div>
                        ${item.image ? `<img src="${item.image}" class="w-100 rounded mb-2">` : ''}
                        <div class="border-top pt-2 mt-1 d-flex gap-3 text-muted small">
                             <span><i class="fas fa-thumbs-up"></i> ${item.like_count}</span>
                             <span><i class="fas fa-comment"></i> ${item.comment_count}</span>
                        </div>
                    </div>`;
        });
        $('#teamFeedList').html(html);
      }, 'json');
    }

    function submitTeamPost() {
      let fd = new FormData($('#createTeamPostForm')[0]);
      // Form already includes CSRF token hidden input
      $.ajax({
        url: 'api.php', type: 'POST', data: fd, contentType: false, processData: false,
        success: function(res) {
          if(res.status === 'success') {
            $('#teamPostModal').modal('hide');
            $('#createTeamPostForm')[0].reset();
            loadTeamPosts();
          } else {
            alert(res.message || 'Error');
          }
        }
      });
    }
  }

  const page = (csrf, inTeam) => `<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Team</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    
    <!-- CSRF Token for JavaScript -->
    <script>
        const CSRF_TOKEN = '${csrf}';
    </script>

    <style>${CSS}</style>
</head>
<body>

${!inTeam ? `
    <div class="d-flex flex-column justify-content-center align-items-center vh-100 p-4 text-center">
        <i class="fas fa-users-slash fa-4x text-muted mb-3"></i>
        <h4>কোনো টিম নেই!</h4>
        <p class="text-muted">আপনি বর্তমানে কোনো টিমের সদস্য নন। টিমে যুক্ত হতে এডমিনের সাথে যোগাযোগ করুন।</p>
        <a href="index.php" class="btn btn-primary mt-3">হোম পেজে ফিরুন</a>
    </div>
` : `
    <div id="teamArea">
        <div class="text-center mt-5"><i class="fas fa-spinner fa-spin fa-2x"></i></div>
    </div>

    <!-- Create Team Post Modal -->
    <div class="modal fade" id="teamPostModal">
        <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
                <div class="modal-body">
                    <form id="createTeamPostForm">
                        <input type="hidden" name="csrf_token" value="${csrf}">
                        <input type="hidden" name="action" value="create_post">
                        <input type="hidden" name="scope" value="team">
                        <textarea name="content" class="form-control border-0 fs-5 mb-3" placeholder="টিম মেম্বারদের জন্য পোস্ট..." style="min-height:100px" required></textarea>
                        <input type="file" name="image" class="form-control form-control-sm mb-3" accept="image/*">
                        <button type="button" class="btn btn-success w-100 rounded-pill" onclick="submitTeamPost()">পোস্ট করুন</button>
                    </form>
                </div>
            </div>
        </div>
    </div>

    <div class="bottom-nav">
        <a href="index.php"><i class="fas fa-home"></i></a>
        <a href="team.php" class="active-nav"><i class="fas fa-users"></i></a>
        <a href="#" onclick="alert('Global Chat is on Home Page')"><i class="fas fa-comments"></i></a>
    </div>

    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script>
    ${scriptBody(clientTeam)}
    </script>
`}
</body>
</html>`;

  router.get('/team.php', async (req, res) => {
    // Authentication Check
    const me = await currentUser(req);
    if (!me) { if (req.sess.uid) logout(req, res); return res.redirect('/index.php'); }
    res.type('html').send(page(req.sess.csrf, me.team_id > 0));
  });

  return router;
};
