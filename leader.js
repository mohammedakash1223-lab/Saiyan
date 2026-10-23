'use strict';
/** leader.js — port of leader.php (served at /leader.php). */
const express = require('express');

module.exports = (core) => {
  const { M, one, h, currentUser, logout, scriptBody } = core;
  const router = express.Router();

  function clientLeader() {
    /* global $, CSRF_TOKEN */
    function subNotice() {
      // Serialize includes the csrf_token hidden input
      $.post('api.php', $('#noticeForm').serialize(), function(res){
        if(res.status==='success') {
          alert('নোটিশ পাবলিশ হয়েছে!');
          $('#noticeForm')[0].reset();
        }
        else alert(res.message);
      }, 'json');
    }

    function subMission() {
      let fd = new FormData($('#missionForm')[0]);
      // FormData includes csrf_token hidden input automatically
      $.ajax({
        url: 'api.php', type: 'POST', data: fd, contentType: false, processData: false,
        success: function(res) {
          if(res.status==='success') {
            alert(res.message);
            $('#missionForm')[0].reset();
          }
          else alert(res.message);
        }
      });
    }
  }

  router.get('/leader.php', async (req, res) => {
    // Authentication Check
    const me = await currentUser(req);
    if (!me) { if (req.sess.uid) logout(req, res); return res.redirect('/index.php'); }

    // Fresh team id from DB; user must be leader of THIS team
    const team = me.team_id > 0 ? await one(M.Team, { id: me.team_id, leader_id: me.id }) : null;

    // Access Control
    if (!team) {
      return res.type('html').send(`<div style='font-family:sans-serif; text-align:center; margin-top:50px;'>
<h3 style='color:red;'>Access Denied</h3>
<p>You are not the leader of this team.</p>
<a href='index.php' style='padding:10px 20px; background:#008080; color:white; text-decoration:none; border-radius:5px;'>Go Home</a>
</div>`);
    }

    const csrf = req.sess.csrf;
    res.type('html').send(`<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Leader Dashboard</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    
    <!-- CSRF Token for JavaScript -->
    <script>
        const CSRF_TOKEN = '${csrf}';
    </script>
    
    <style>body{background:#f8f9fa}</style>
</head>
<body class="p-3">
    <div class="d-flex justify-content-between align-items-center mb-4">
        <h4 class="fw-bold text-primary"><i class="fas fa-crown"></i> ${h(team.team_name)} Leader</h4>
        <a href="team.php" class="btn btn-outline-secondary btn-sm">Back to Team</a>
    </div>

    <!-- Create Notice -->
    <div class="card shadow-sm mb-4">
        <div class="card-header bg-info text-white fw-bold">টিম নোটিশ দিন</div>
        <div class="card-body">
            <form id="noticeForm">
                <input type="hidden" name="csrf_token" value="${csrf}">
                <input type="hidden" name="action" value="create_team_notice">
                <input type="text" name="title" class="form-control mb-2" placeholder="নোটিশ শিরোনাম" required>
                <textarea name="message" class="form-control mb-2" placeholder="বিস্তারিত..." required></textarea>
                <button type="button" onclick="subNotice()" class="btn btn-info text-white w-100">পোস্ট নোটিশ</button>
            </form>
        </div>
    </div>

    <!-- Create Mission -->
    <div class="card shadow-sm">
        <div class="card-header bg-danger text-white fw-bold">মিশন তৈরি করুন (Admin Approval Required)</div>
        <div class="card-body">
            <form id="missionForm" enctype="multipart/form-data">
                <input type="hidden" name="csrf_token" value="${csrf}">
                <input type="hidden" name="action" value="create_team_mission">
                <input type="text" name="title" class="form-control mb-2" placeholder="মিশনের নাম" required>
                <textarea name="desc" class="form-control mb-2" placeholder="কি করতে হবে?" required></textarea>
                <input type="number" name="points" class="form-control mb-2" placeholder="পয়েন্টস (যেমন: 50)" required>
                <label class="small text-muted">ছবি (অপশনাল)</label>
                <input type="file" name="image" class="form-control mb-3" accept="image/*">
                <button type="button" onclick="subMission()" class="btn btn-danger w-100">মিশন রিকোয়েস্ট পাঠান</button>
            </form>
        </div>
    </div>

    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script>
    ${scriptBody(clientLeader)}
    </script>
</body>
</html>`);
  });

  return router;
};
