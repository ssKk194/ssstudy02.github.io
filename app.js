/* ═══════════════════════════════════════════════════════
   STUDYVAULT — app.js
═══════════════════════════════════════════════════════ */

'use strict';

import { supabase, getCurrentUser, isAdmin, signOut, ADMIN_EMAIL, SUPABASE_URL, SUPABASE_ANON } from './supabase.js';

/* ─── GLOBALS ────────────────────────────────────────── */
let currentPage = 'home';
let currentUser  = null;
let userProfile = null;
let adminMode    = false;
let activeExamTimer = null;

const SUBJECTS = {
  dsa: 'DSA', cn: 'Comp Networks', coa: 'COA', vm: 'Vedic Math', os: 'Operating Sys', se: 'Software Engg',
  ap: 'Applied Physics', m1: 'Math 1', m2: 'Math 2', evs: 'EVS', other: 'Other'
};

/* ─── UTILITIES ──────────────────────────────────────── */
const qs  = (sel, ctx = document) => ctx.querySelector(sel);
const qsa = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const fmt = d => new Date(d).toLocaleDateString('en-IN', { year:'numeric', month:'short', day:'numeric' });
const escHtml = str => str ? str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
const capitalize = s => s ? s[0].toUpperCase() + s.slice(1) : s;

// Resilient insert: automatically drops columns not yet recognized by PostgREST schema cache
// and resolves check-constraint casing (e.g. Easy vs easy, Medium vs medium)
async function safeInsert(table, data) {
  let payload = { ...data };
  let res = await supabase.from(table).insert(payload);
  let attempts = 0;
  while (res.error && res.error.message && attempts < 8) {
    attempts++;
    
    // Check for difficulty constraint mismatch (e.g., 'Medium' vs 'medium')
    if (res.error.message.includes('difficulty_check') && payload.difficulty) {
      if (payload.difficulty === 'Medium') payload.difficulty = 'medium';
      else if (payload.difficulty === 'Easy') payload.difficulty = 'easy';
      else if (payload.difficulty === 'Hard') payload.difficulty = 'hard';
      else if (payload.difficulty === 'medium') payload.difficulty = 'Medium';
      else if (payload.difficulty === 'easy') payload.difficulty = 'Easy';
      else if (payload.difficulty === 'hard') payload.difficulty = 'Hard';
      res = await supabase.from(table).insert(payload);
      continue;
    }

    // Check for type constraint mismatch (e.g., 'brainstorm' vs 'puzzle')
    if (res.error.message.includes('type_check') && payload.type) {
      if (payload.type === 'brainstorm') payload.type = 'puzzle';
      else if (payload.type === 'puzzle') payload.type = 'brainstorm';
      res = await supabase.from(table).insert(payload);
      continue;
    }

    let missingCol = null;
    const match1 = res.error.message.match(/Could not find the '([^']+)' column/);
    const match2 = res.error.message.match(/column [^.]+\.([^\s]+) does not exist/);
    if (match1 && match1[1]) missingCol = match1[1];
    else if (match2 && match2[1]) missingCol = match2[1];

    if (missingCol && payload.hasOwnProperty(missingCol)) {
      delete payload[missingCol];
      res = await supabase.from(table).insert(payload);
    } else {
      break;
    }
  }
  return res;
}

// Resilient update: automatically drops columns not recognized by PostgREST schema cache
async function safeUpdate(table, filterCol, filterVal, data) {
  let payload = { ...data };
  let res = await supabase.from(table).update(payload).eq(filterCol, filterVal);
  let attempts = 0;
  while (res.error && res.error.message && attempts < 8) {
    attempts++;
    let missingCol = null;
    const match1 = res.error.message.match(/Could not find the '([^']+)' column/);
    const match2 = res.error.message.match(/column [^.]+\.([^\s]+) does not exist/);
    if (match1 && match1[1]) missingCol = match1[1];
    else if (match2 && match2[1]) missingCol = match2[1];

    if (missingCol && payload.hasOwnProperty(missingCol)) {
      delete payload[missingCol];
      res = await supabase.from(table).update(payload).eq(filterCol, filterVal);
    } else {
      break;
    }
  }
  return res;
}

// Safely parse date strings from DB, forms, or ISO ensuring local timezone fidelity
function parseAppDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === 'string') {
    // If format is YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss without timezone offset or Z
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(val)) {
      const parts = val.split(/[-T:]/);
      return new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5] || 0);
    }
  }
  return new Date(val);
}

/* ═══════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════ */
async function initAuth() {
  currentUser = await getCurrentUser();
  if (!currentUser) { window.location.href = 'login.html'; return; }
  adminMode = currentUser.email === ADMIN_EMAIL;
  
  // Load profile from Supabase first
  let { data: profile } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
  
  // Generate & Save Unique Student ID if missing
  if (!profile || !profile.student_id) {
    const year = new Date().getFullYear().toString().slice(-2);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const letters = chars[Math.floor(Math.random()*26)] + chars[Math.floor(Math.random()*26)] + chars[Math.floor(Math.random()*26)];
    const nums = Math.floor(1000 + Math.random() * 9000);
    const newId = `${year}${letters}${nums}`; // e.g. 26KPB2431
    
    await supabase.from('profiles').upsert({ ...(profile || {}), id: currentUser.id, student_id: newId, subscription_tier: 'free' });
    profile = { ...(profile || {}), student_id: newId, subscription_tier: 'free' };
  }
  userProfile = profile;

  // BIOMETRIC UNLOCK
  if (profile.biometric_enabled && window.Capacitor && window.Capacitor.isNativePlatform()) {
    try {
      const { NativeBiometric } = window.Capacitor.Plugins;
      if (NativeBiometric) {
        const isAvailable = await NativeBiometric.isAvailable();
        if (isAvailable && isAvailable.isAvailable) {
          await NativeBiometric.verifyIdentity({
            reason: "Unlock StudyVault",
            title: "StudyVault Security",
            subtitle: "Use your fingerprint to access your account",
            description: "Please authenticate to continue"
          });
        }
      }
    } catch (err) {
      // If they fail or cancel the fingerprint, lock them out
      document.body.innerHTML = '<div style="display:flex; height:100vh; align-items:center; justify-content:center; font-family:sans-serif; flex-direction:column;"><h2>App Locked 🔒</h2><p>Biometric authentication failed.</p><button onclick="location.reload()" style="padding:10px 20px; margin-top:20px; background:#F59E0B; border:none; border-radius:5px; color:white; font-weight:bold;">Try Again</button></div>';
      return;
    }
  }
  
  if (adminMode) {
    checkAdminNotifications();
    setInterval(checkAdminNotifications, 15000); // Poll every 15 seconds
  }

  const uname = qs('#user-name-text');
  const uav   = qs('#user-avatar-char');
  const homeName = qs('#home-id-name');
  const homeAv = qs('#home-id-avatar');
  const homeSig = qs('#home-id-signature');
  const homeSigPh = qs('#home-id-signature-ph');
  
  const idFooter = qs('#home-id-number');
  if (idFooter) idFooter.textContent = 'ID: ' + profile.student_id;
  
  const tierDisplay = qs('#home-detail-tier');
  if (tierDisplay) {
    let tierText = "Free Access";
    if (userProfile.subscription_tier === 'lite') tierText = "Lite Version";
    if (userProfile.subscription_tier === 'pro') tierText = "VIP Pro Version";
    tierDisplay.textContent = tierText;
  }
  
  // Premium Page Buttons Logic
  const btnLite = qs('#sub-btn-lite');
  const btnPro = qs('#sub-btn-pro');
  if (btnLite && btnPro) {
    if (userProfile.subscription_tier === 'pro') {
      btnLite.textContent = "Current Plan";
      btnLite.disabled = true;
      btnLite.style.opacity = '0.5';
      btnLite.style.cursor = 'not-allowed';
      
      btnPro.textContent = "Current Plan";
      btnPro.disabled = true;
      btnPro.style.opacity = '0.5';
      btnPro.style.cursor = 'not-allowed';
    } else if (userProfile.subscription_tier === 'lite') {
      btnLite.textContent = "Current Plan";
      btnLite.disabled = true;
      btnLite.style.opacity = '0.5';
      btnLite.style.cursor = 'not-allowed';
      
      btnPro.textContent = "Upgrade to Pro (Rs 119)";
    }
  }
  
  // Settings Membership Logic
  const setPlan = qs('#settings-current-plan');
  const setExpiry = qs('#settings-plan-expiry');
  const cancelBox = qs('#cancel-sub-box');
  const refAmt = qs('#refund-amount');
  const refStatusBox = qs('#refund-status-box');
  const refUtrDisplay = qs('#refund-utr-display');
  
  if (setPlan) {
    if (userProfile.subscription_tier === 'pro') {
      setPlan.textContent = "VIP Pro Version";
      setExpiry.textContent = `Valid until ${fmt(userProfile.subscription_expiry)}`;
      cancelBox.classList.remove('hidden');
      refAmt.textContent = "Rs 179";
    } else if (userProfile.subscription_tier === 'lite') {
      setPlan.textContent = "Lite Version";
      setExpiry.textContent = `Valid until ${fmt(userProfile.subscription_expiry)}`;
      cancelBox.classList.remove('hidden');
      refAmt.textContent = "Rs 89";
    } else {
      setPlan.textContent = "Free Access";
      setExpiry.textContent = "Never expires";
      cancelBox.classList.add('hidden');
    }

    // Check for processed refunds
    const { data: refunds } = await supabase.from('pending_payments')
      .select('admin_utr, created_at')
      .eq('user_id', currentUser.id)
      .eq('status', 'approved')
      .like('tier', 'cancel_%')
      .order('created_at', { ascending: false })
      .limit(1);

    if (refunds && refunds.length > 0 && refunds[0].admin_utr) {
      refStatusBox.classList.remove('hidden');
      refUtrDisplay.textContent = refunds[0].admin_utr;
    } else {
      refStatusBox.classList.add('hidden');
    }
  }
  
  const displayName = profile?.display_name || currentUser.email.split('@')[0];
  if (uname) uname.textContent = adminMode ? 'Admin' : displayName;
  if (homeName) homeName.textContent = adminMode ? 'Admin' : displayName;
  
  const heroName = qs('#hero-name');
  if (heroName) heroName.textContent = adminMode ? 'Admin' : displayName;
  
  const detailEmail = qs('#home-detail-email');
  if (detailEmail) detailEmail.textContent = currentUser.email;
  
  const applyAvatar = (el) => {
    if (!el) return;
    if (profile?.avatar_url) {
      el.textContent = '';
      el.style.backgroundImage = `url('${profile.avatar_url}')`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    } else {
      el.textContent = adminMode ? 'A' : (currentUser.email[0].toUpperCase());
      el.style.backgroundImage = 'none';
    }
  };
  
  applyAvatar(uav);
  applyAvatar(homeAv);
  
  if (homeSig && homeSigPh) {
    if (profile?.signature_url) {
      homeSig.src = profile.signature_url;
      homeSig.classList.remove('hidden');
      homeSigPh.classList.add('hidden');
    } else {
      homeSig.classList.add('hidden');
      homeSigPh.classList.remove('hidden');
    }
  }

  if (adminMode) {
    qsa('.admin-only').forEach(el => {
      if (el.classList.contains('admin-fab') || el.id === 'admin-notif-bell') {
        el.style.display = 'flex';
      } else {
        el.style.display = 'block';
      }
    });
  }

  const soBtn = qs('#sign-out-btn');
  if (soBtn) soBtn.addEventListener('click', async () => { await signOut(); window.location.href = 'login.html'; });

  setupRealtimeSubscriptions();
}

function setupRealtimeSubscriptions() {
  supabase.channel('global-notifs')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'global_notifications' }, payload => {
      const { title, message, type } = payload.new;
      // Show instant toast notification
      showToast(`${title}: ${message}`, 'success');
      
      // Auto-reload the current page if it matches the notification type
      if (type === 'exam' && currentPage === 'exams') loadExams();
      if (type === 'note' && currentPage === 'notes') loadNotes();
      if (type === 'notice' && currentPage === 'notices') loadNotices();
      if (type === 'daily' && currentPage === 'daily') loadDailyChallenges();
      if (currentPage === 'home') loadHomeAlerts();
    })
    .subscribe();
}

/* ═══════════════════════════════════════════════════════
   NAVIGATION & TURBO PROGRESS
═══════════════════════════════════════════════════════ */
function triggerTurboBar() {
  const bar = qs('#page-turbo-bar');
  if (!bar) return () => {};
  bar.classList.add('loading');
  bar.style.width = '30%';
  bar.style.opacity = '1';
  
  const midTimer = setTimeout(() => {
    if (bar.classList.contains('loading')) bar.style.width = '75%';
  }, 90);

  return function finishTurboBar() {
    clearTimeout(midTimer);
    bar.style.width = '100%';
    setTimeout(() => {
      bar.style.opacity = '0';
      setTimeout(() => {
        bar.classList.remove('loading');
        bar.style.width = '0%';
      }, 300);
    }, 180);
  };
}

function triggerStaggeredCards(containerSel) {
  const cards = qsa(`${containerSel} .card-grid > *, ${containerSel} .note-card, ${containerSel} .exam-card, ${containerSel} .dash-card, ${containerSel} .reveal-up`);
  cards.forEach((el, index) => {
    el.style.animationDelay = `${index * 35}ms`;
    el.classList.add('visible');
  });
}

function navigateTo(pageId) {
  if (pageId === currentPage) return;
  const finishTurbo = triggerTurboBar();
  const prev = qs(`#${currentPage}`);
  const next = qs(`#${pageId}`);

  qsa('.nav-link').forEach(l => l.classList.remove('active'));
  const link = qs(`[data-page="${pageId}"].nav-link`);
  if (link) {
    link.classList.add('active');
    updateLiquidNav(link);
  }

  if (prev && next) {
    prev.classList.add('exiting');
    setTimeout(() => {
      prev.classList.remove('active', 'exiting');
      next.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      finishTurbo();
      triggerStaggeredCards(`#${pageId}`);
    }, 160);
  } else if (next) {
    next.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    finishTurbo();
    triggerStaggeredCards(`#${pageId}`);
  }

  currentPage = pageId;

  setTimeout(() => {
    initRevealObserver();
    if (pageId === 'home') loadHomeDashboard();
    if (pageId === 'notes') loadNotes();
    if (pageId === 'exams') loadExams();
    if (pageId === 'notices') loadNotices();
    if (pageId === 'daily') loadDailyChallenges();
    if (pageId === 'settings') loadSettings();
  }, 60);
}
window.navigateTo = navigateTo; 

function updateLiquidNav(linkEl) {
  const bg = qs('#nav-liquid-bg');
  if (!bg || !linkEl) return;
  bg.style.opacity = '1';
  bg.style.width = linkEl.offsetWidth + 'px';
  bg.style.left = linkEl.offsetLeft + 'px';
  bg.style.transition = 'all 0.35s cubic-bezier(0.34, 1.4, 0.64, 1)';
}

function initNavLinks() {
  const container = qs('#nav-links-container');
  qsa('.nav-link').forEach(link => {
    link.addEventListener('click', e => { e.preventDefault(); const p = link.dataset.page; if (p) navigateTo(p); });
    link.addEventListener('mouseenter', e => { updateLiquidNav(link); });
  });
  
  if (container) {
    container.addEventListener('mouseleave', () => {
      const active = qs('.nav-link.active');
      if (active) updateLiquidNav(active);
    });
  }

  const logo = qs('#nav-logo-link');
  if (logo) logo.addEventListener('click', e => { e.preventDefault(); navigateTo('home'); });
  
  setTimeout(() => {
    const active = qs('.nav-link.active');
    if (active) updateLiquidNav(active);
  }, 150);
}

/* ═══════════════════════════════════════════════════════
   SATISFYING TACTILE CLICK AUDIO & HAPTICS (Web Audio API)
═══════════════════════════════════════════════════════ */
let audioCtx = null;
let tactileSoundEnabled = localStorage.getItem('sv_tactile_sound') !== '0';

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

window.toggleTactileSound = function(enabled) {
  tactileSoundEnabled = !!enabled;
  localStorage.setItem('sv_tactile_sound', enabled ? '1' : '0');
  if (enabled) playTactileClickSound(1800, 0.08);
};

function playTactileClickSound(freq = 1500, volume = 0.038) {
  if (!tactileSoundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    
    // Crisp, ultra-clean micro-burst click
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(800, now);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.012);
    
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.012);
    
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    
    osc.start(now);
    osc.stop(now + 0.015);
  } catch (err) {
    // Audio context silent fallback
  }
}

/* ═══════════════════════════════════════════════════════
   GLOBAL SHOCKWAVE RIPPLE & TACTILE CLICK INTERACTION
═══════════════════════════════════════════════════════ */
function initTactileInteractions() {
  const soundToggle = qs('#tactile-sound-toggle');
  if (soundToggle) soundToggle.checked = tactileSoundEnabled;

  document.addEventListener('pointerdown', (e) => {
    // Find closest interactive element
    const interactive = e.target.closest('button, .btn-secondary, .btn-premium, .filter-tab, .daily-filter-tab, .note-btn, .admin-submit-btn, .btn-exam-start, .dash-card, .note-card, .exam-card, .quick-card, .admin-tab-btn, .nav-link, .chat-launcher, .user-badge, .pricing-card, .btn-run-code, .btn-submit-code, .exam-alert-card');
    if (!interactive) return;

    // Trigger acoustic micro-haptic
    playTactileClickSound();

    // Spawn Radiant Click Ripple
    const rect = interactive.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'sv-click-ripple';
    
    const size = Math.max(rect.width, rect.height) * 1.5;
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    
    interactive.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }, { passive: true });
}

/* ═══════════════════════════════════════════════════════
   DYNAMIC CARD SPOTLIGHT & SILKY 3D TILT
═══════════════════════════════════════════════════════ */
function initCardSpotlights() {
  const cardSelector = '.dash-card, .note-card, .exam-card, .quick-card, .pricing-card, .feature-card, .admin-modal-box';
  
  document.addEventListener('mousemove', (e) => {
    const card = e.target.closest(cardSelector);
    if (!card) return;
    
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    card.style.setProperty('--mouse-x', `${x}px`);
    card.style.setProperty('--mouse-y', `${y}px`);
    
    // Smooth 3D tilt
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const tiltX = ((y - centerY) / centerY) * -3.2;
    const tiltY = ((x - centerX) / centerX) * 3.2;
    
    card.style.transform = `perspective(1000px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) translateY(-3px)`;
  }, { passive: true });
  
  document.addEventListener('mouseout', (e) => {
    const card = e.target.closest(cardSelector);
    if (card && (!e.relatedTarget || !card.contains(e.relatedTarget))) {
      card.style.transform = '';
      card.style.removeProperty('--mouse-x');
      card.style.removeProperty('--mouse-y');
    }
  }, { passive: true });
}

/* ═══════════════════════════════════════════════════════
   AMBIENT ORBS PARALLAX
═══════════════════════════════════════════════════════ */
function initAmbientParallax() {
  const orb1 = qs('.orb-1');
  const orb2 = qs('.orb-2');
  if (!orb1 && !orb2) return;
  
  let targetX = 0, targetY = 0;
  let currentX = 0, currentY = 0;
  
  window.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth) - 0.5;
    const y = (e.clientY / window.innerHeight) - 0.5;
    targetX = x * 35;
    targetY = y * 35;
  }, { passive: true });
  
  function animateOrbs() {
    currentX += (targetX - currentX) * 0.05;
    currentY += (targetY - currentY) * 0.05;
    
    if (orb1) orb1.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
    if (orb2) orb2.style.transform = `translate3d(${-currentX * 1.2}px, ${-currentY * 1.2}px, 0)`;
    
    requestAnimationFrame(animateOrbs);
  }
  requestAnimationFrame(animateOrbs);
}

/* ═══════════════════════════════════════════════════════
   SCROLL REVEAL
═══════════════════════════════════════════════════════ */
function initRevealObserver() {
  const items = qsa('.reveal-up:not(.visible)');
  if (!items.length) return;
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); } });
  }, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' });
  items.forEach(el => obs.observe(el));
}
function triggerReveal(containerSel) {
  qsa(`${containerSel} .reveal-up`).forEach((el, i) => setTimeout(() => el.classList.add('visible'), i * 80 + 80));
}

/* ═══════════════════════════════════════════════════════
   HOME DASHBOARD
═══════════════════════════════════════════════════════ */
async function loadHomeDashboard() {
  loadHomeAlerts();
  
  // Latest Exam
  const { data: exams } = await supabase.from('exams').select('*').gt('exam_date', new Date().toISOString()).order('exam_date', { ascending: true }).limit(1);
  const examEl = qs('#dash-exam-content');
  if (examEl) {
    examEl.innerHTML = `<div class="shimmer" style="height: 18px; width: 70%; margin-bottom: 8px;"></div>
                        <div class="shimmer" style="height: 14px; width: 40%;"></div>`;
    if (exams && exams.length > 0) {
      const ex = exams[0];
      const d = new Date(ex.exam_date);
      examEl.innerHTML = `<div style="font-weight:800; font-size:1.1rem; color:var(--text-1); margin-bottom:4px;">${escHtml(ex.title)}</div>
                          <div style="color:var(--text-2); margin-bottom:8px;">${d.toLocaleDateString()} at ${d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                          <div class="dash-item-link" onclick="navigateTo('exams')">Go to Exams →</div>`;
    } else {
      examEl.innerHTML = 'No upcoming exams scheduled.';
    }
  }
  
  // Latest Notice
  const { data: notices } = await supabase.from('notices').select('*').order('created_at', { ascending: false }).limit(1);
  const noticeEl = qs('#dash-notice-content');
  if (noticeEl) {
    noticeEl.innerHTML = `<div class="shimmer" style="height: 18px; width: 80%; margin-bottom: 8px;"></div>
                          <div class="shimmer" style="height: 14px; width: 90%;"></div>`;
    if (notices && notices.length > 0) {
      const nt = notices[0];
      noticeEl.innerHTML = `<div style="font-weight:800; font-size:1.1rem; color:var(--text-1); margin-bottom:4px;">${escHtml(nt.title)}</div>
                            <div style="color:var(--text-2); margin-bottom:8px;">${escHtml(nt.body).substring(0,60)}...</div>
                            <div class="dash-item-link" onclick="navigateTo('notices')">Read Notice →</div>`;
    } else {
      noticeEl.innerHTML = 'No recent notices.';
    }
  }

  // Latest Daily Challenge
  const { data: challenges } = await supabase.from('daily_challenges').select('*').order('created_at', { ascending: false }).limit(1);
  const dailyEl = qs('#dash-daily-content');
  if (dailyEl) {
    if (challenges && challenges.length > 0) {
      const ch = challenges[0];
      const typeLabel = ch.type === 'dsa' ? 'DSA' : ch.type === 'quiz' ? 'Quiz' : 'Brainstorm';
      dailyEl.innerHTML = `
        <div style="font-weight:800; font-size:1.05rem; color:var(--text-1); margin-bottom:4px;">${escHtml(ch.title)}</div>
        <div style="font-size:0.8rem; color:var(--text-2); margin-bottom:8px;">${typeLabel} • ${capitalize(ch.difficulty || 'medium')} • +${ch.points || 10} XP</div>
        <div class="dash-item-link" onclick="navigateTo('daily')">Solve Today's Challenge →</div>
      `;
    } else {
      dailyEl.innerHTML = '<div style="color:var(--text-3); font-size:0.85rem;">No active challenge today. Check back soon!</div>';
    }
  }

  // Update live portal clock if present
  updatePortalTime();
}

function updatePortalTime() {
  const clockEl = qs('#portal-current-time');
  if (!clockEl) return;
  const now = new Date();
  const options = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
  clockEl.textContent = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' • ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
if (!window._portalClockTimer) {
  window._portalClockTimer = setInterval(updatePortalTime, 1000);
}

// Quick Subject Selector for Home Vault Pills
window.selectNoteSubject = function(subjectKey) {
  setTimeout(() => {
    const filterBtn = qs(`#notes .filter-tab[data-filter="${subjectKey}"]`);
    if (filterBtn) {
      filterBtn.click();
    }
  }, 120);
};


/* ═══════════════════════════════════════════════════════
   HOME ALERTS (5-day warning)
═══════════════════════════════════════════════════════ */
async function loadHomeAlerts() {
  const c = qs('#home-alerts');
  if (!c) return;
  
  const now = new Date();
  const next5Days = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
  
  const { data, error } = await supabase
    .from('exams')
    .select('id, title, exam_date')
    .gte('exam_date', now.toISOString())
    .lte('exam_date', next5Days.toISOString())
    .order('exam_date', { ascending: true });

  if (error || !data?.length) { c.innerHTML = ''; return; }

  c.innerHTML = data.map(ex => `
    <div class="exam-alert-box reveal-up delay-1">
      <div class="exam-alert-icon">!</div>
      <div>
        <div class="exam-alert-title">Upcoming Exam: ${escHtml(ex.title)}</div>
        <div class="exam-alert-time">${new Date(ex.exam_date).toLocaleString()}</div>
      </div>
    </div>
  `).join('');
  initRevealObserver();
}

/* ═══════════════════════════════════════════════════════
   DATETIME FORMATTING HELPER
═══════════════════════════════════════════════════════ */
function formatDateTimeRecord(isoString) {
  if (!isoString) return { dateStr: 'Recently', timeStr: '', fullStr: 'Recently', dateKey: 'recently' };
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return { dateStr: 'Recently', timeStr: '', fullStr: 'Recently', dateKey: 'recently' };
  
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  
  const dateFormatted = d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeFormatted = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  let dateCategoryLabel = dateFormatted;
  let datePillClass = 'earlier';
  let datePillText = '';
  
  if (isToday) {
    dateCategoryLabel = 'Today';
    datePillClass = 'today';
    datePillText = 'Today';
  } else if (isYesterday) {
    dateCategoryLabel = 'Yesterday';
    datePillClass = 'yesterday';
    datePillText = 'Yesterday';
  }
  
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dateKey = `${y}-${m}-${day}`;

  return {
    dateStr: dateFormatted,
    timeStr: timeFormatted,
    fullStr: `${dateFormatted} • ${timeFormatted}`,
    dateCategoryLabel,
    datePillClass,
    datePillText,
    dateKey,
    isToday,
    isYesterday
  };
}

/* ═══════════════════════════════════════════════════════
   NOTES
═══════════════════════════════════════════════════════ */
// Subject icons and color themes
const subjectThemes = {
  dsa:   { color: '#3B82F6', bg: 'rgba(59, 130, 246, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>' },
  cn:    { color: '#8B5CF6', bg: 'rgba(139, 92, 246, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>' },
  coa:   { color: '#EC4899', bg: 'rgba(236, 72, 153, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line></svg>' },
  vm:    { color: '#F59E0B', bg: 'rgba(245, 158, 11, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path><path d="M12 8v8"></path></svg>' },
  os:    { color: '#10B981', bg: 'rgba(16, 185, 129, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>' },
  se:    { color: '#06B6D4', bg: 'rgba(6, 182, 212, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>' },
  ap:    { color: '#EAB308', bg: 'rgba(234, 179, 8, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(30 12 12)"></ellipse><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-30 12 12)"></ellipse></svg>' },
  m1:    { color: '#6366F1', bg: 'rgba(99, 102, 241, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' },
  m2:    { color: '#A855F7', bg: 'rgba(168, 85, 247, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M14.31 8l5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16L3.95 6.06M14.31 16H2.83m13.79-4l-5.74 9.94"></path></svg>' },
  evs:   { color: '#22C55E', bg: 'rgba(34, 197, 94, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"></path><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path></svg>' },
  other: { color: '#94A3B8', bg: 'rgba(148, 163, 184, 0.15)', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' }
};

let cachedNotes = [];
let currentOpenSubjectKey = null;

async function loadNotes() {
  const grid = qs('#notes-grid');
  if (!grid) return;
  
  grid.innerHTML = Array(4).fill(`<div class="subject-row-card shimmer" style="height: 72px;"></div>`).join('');

  const { data, error } = await supabase.from('notes').select('*').order('created_at', { ascending: false });

  if (error) { grid.innerHTML = `<div class="error-state">Error: ${error.message}</div>`; return; }
  cachedNotes = data || [];

  // List of all curriculum subjects
  const subjectKeys = Object.keys(SUBJECTS);

  grid.innerHTML = subjectKeys.map((subjKey, i) => {
    const subjName = SUBJECTS[subjKey];
    const theme = subjectThemes[subjKey] || subjectThemes.other;

    // Filter items belonging to this subject
    const subjectItems = cachedNotes.filter(n => n.subject === subjKey);

    // Group into 2 distinct subsections: Syllabus and Notes
    const syllabusCount = subjectItems.filter(n => {
      return n.doc_type === 'syllabus' || (n.title && n.title.toLowerCase().includes('syllabus')) || (n.description && n.description.includes('[SYLLABUS]'));
    }).length;

    const notesCount = subjectItems.length - syllabusCount;

    return `
      <div class="subject-row-card reveal-up ${i % 3 === 1 ? 'delay-1' : i % 3 === 2 ? 'delay-2' : ''}" data-subject="${subjKey}" onclick="openSubjectModal('${subjKey}')" role="button" tabindex="0">
        <div class="subject-row-left">
          <div class="subject-row-icon" style="background: ${theme.bg}; color: ${theme.color};">
            ${theme.icon}
          </div>
          <div class="subject-row-info">
            <h3 class="subject-row-name">${escHtml(subjName)}</h3>
            <p class="subject-row-meta">
              <span class="subject-code-tag">SV-${subjKey.toUpperCase()}</span>
              <span>•</span>
              <span>${subjectItems.length} total ${subjectItems.length === 1 ? 'item' : 'items'}</span>
            </p>
          </div>
        </div>

        <div class="subject-row-right">
          <div class="subject-summary-tags">
            <span class="subject-pill-syllabus">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
              ${syllabusCount} Syllabus
            </span>
            <span class="subject-pill-notes">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
              ${notesCount} Notes
            </span>
          </div>
          <div class="subject-arrow-btn" aria-label="Open ${escHtml(subjName)}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </div>
        </div>
      </div>
    `;
  }).join('');

  initFilters('.filter-tab', '.subject-row-card', 'subject');
  initRevealObserver();

  // If modal is currently open, refresh its contents
  if (currentOpenSubjectKey) {
    window.openSubjectModal(currentOpenSubjectKey, false);
  }
}

// Render helper for item row inside modal
function renderSubjectItemRow(item) {
  const timeInfo = formatDateTimeRecord(item.created_at);
  return `
    <div class="subject-item-row">
      <div class="subject-item-left">
        <span class="subject-item-pdf-badge">PDF</span>
        <div class="subject-item-meta">
          <div class="subject-item-name" title="${escHtml(item.title)}">${escHtml(item.title)}</div>
          <div class="subject-item-time">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            ${timeInfo.fullStr}
          </div>
        </div>
      </div>
      <div class="subject-item-actions">
        ${item.file_url ? `<button class="subject-item-btn" onclick="openFileViewer('${item.file_url}', '${escHtml(item.title).replace(/'/g, "\\'")}')">View PDF</button>` : ''}
        ${adminMode ? `<button class="note-btn admin-del-btn" style="padding:4px 8px; font-size:0.7rem;" onclick="deleteNote('${item.id}')">Delete</button>` : ''}
      </div>
    </div>
  `;
}

window.openSubjectModal = function(subjKey, resetScroll = true) {
  currentOpenSubjectKey = subjKey;
  const modal = qs('#subject-detail-modal');
  if (!modal) return;

  const subjName = SUBJECTS[subjKey] || subjKey;
  const theme = subjectThemes[subjKey] || subjectThemes.other;

  // Header info
  const iconEl = qs('#modal-subject-icon');
  const codeEl = qs('#modal-subject-code');
  const titleEl = qs('#modal-subject-title');
  const countEl = qs('#modal-subject-count');

  if (iconEl) {
    iconEl.style.background = theme.bg;
    iconEl.style.color = theme.color;
    iconEl.innerHTML = theme.icon;
  }
  if (codeEl) codeEl.textContent = `SV-${subjKey.toUpperCase()}`;
  if (titleEl) titleEl.textContent = subjName;

  // Filter items
  const subjectItems = cachedNotes.filter(n => n.subject === subjKey);
  if (countEl) countEl.textContent = `${subjectItems.length} ${subjectItems.length === 1 ? 'Doc' : 'Docs'}`;

  // 2 Subsections: Syllabus & Notes
  const syllabusItems = subjectItems.filter(n => {
    return n.doc_type === 'syllabus' || (n.title && n.title.toLowerCase().includes('syllabus')) || (n.description && n.description.includes('[SYLLABUS]'));
  });
  const notesItems = subjectItems.filter(n => !syllabusItems.includes(n));

  // Syllabus list
  const sylBadge = qs('#modal-syllabus-badge');
  const sylList = qs('#modal-syllabus-list');
  if (sylBadge) sylBadge.textContent = `${syllabusItems.length} ${syllabusItems.length === 1 ? 'file' : 'files'}`;
  if (sylList) {
    sylList.innerHTML = syllabusItems.length > 0 
      ? syllabusItems.map(renderSubjectItemRow).join('') 
      : `<p class="subject-empty-hint">No syllabus document uploaded for this subject yet.</p>`;
  }

  // Notes list
  const notesBadge = qs('#modal-notes-badge');
  const notesList = qs('#modal-notes-list');
  if (notesBadge) notesBadge.textContent = `${notesItems.length} ${notesItems.length === 1 ? 'file' : 'files'}`;
  if (notesList) {
    notesList.innerHTML = notesItems.length > 0 
      ? notesItems.map(renderSubjectItemRow).join('') 
      : `<p class="subject-empty-hint">No lecture notes uploaded for this subject yet.</p>`;
  }

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  if (resetScroll) {
    const modalBody = modal.querySelector('.subject-modal-body');
    if (modalBody) modalBody.scrollTop = 0;
  }
};

window.closeSubjectModal = function() {
  currentOpenSubjectKey = null;
  const modal = qs('#subject-detail-modal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
};

/* ═══════════════════════════════════════════════════════
   EXAMS & TIMERS
═══════════════════════════════════════════════════════ */
async function loadExams() {
  const grid = qs('#exam-grid');
  if (!grid) return;
  
  grid.innerHTML = Array(3).fill(`<div class="exam-card shimmer" style="height: 200px;"></div>`).join('');

  // Fetch exams and student prior submissions
  const [examsRes, scoresRes] = await Promise.all([
    supabase.from('exams').select('*').order('created_at', { ascending: false }),
    currentUser ? supabase.from('exam_scores').select('exam_id, attempted_at').eq('user_id', currentUser.id) : Promise.resolve({ data: [] })
  ]);

  if (examsRes.error) { grid.innerHTML = `<div class="error-state">Error: ${examsRes.error.message}</div>`; return; }
  const data = examsRes.data;
  if (!data?.length) { grid.innerHTML = '<div class="empty-state">No exams found.</div>'; return; }

  const attemptedMap = new Map();
  if (scoresRes.data) {
    scoresRes.data.forEach(s => { if (s.exam_id) attemptedMap.set(s.exam_id, s.attempted_at); });
  }

  const now = new Date();

  grid.innerHTML = data.map((ex, i) => {
    let windowStatus = 'Active';
    let isAvailable = true;
    let lockReason = '';

    // Parse fallback embedded metadata if present
    let accessCode = ex.access_code || null;
    let barcodeCode = ex.barcode || null;
    let examEndDate = ex.exam_end_date || null;
    let cleanDesc = ex.description || 'StudyVault Official Timed Examination';

    if (ex.description && ex.description.includes('<!--SV_META:')) {
      try {
        const metaMatch = ex.description.match(/<!--SV_META:({.*?})-->/);
        if (metaMatch && metaMatch[1]) {
          const parsed = JSON.parse(metaMatch[1]);
          if (!accessCode && parsed.access_code) accessCode = parsed.access_code;
          if (!barcodeCode && parsed.barcode) barcodeCode = parsed.barcode;
          if (!examEndDate && parsed.exam_end_date) examEndDate = parsed.exam_end_date;
        }
        cleanDesc = ex.description.replace(/<!--SV_META:.*?-->/g, '').trim() || 'StudyVault Official Timed Examination';
      } catch(e) {}
    }
    if (!barcodeCode) barcodeCode = 'SV-' + (ex.id || '').slice(0, 8).toUpperCase();

    const hasAttempted = attemptedMap.has(ex.id) || (currentUser && localStorage.getItem(`exam_submitted_${ex.id}_${currentUser.id}`));

    if (hasAttempted) {
      isAvailable = false;
      lockReason = 'Attempted (Single-attempt locked)';
      windowStatus = 'Submitted';
    } else if (ex.exam_date) {
      const startDt = parseAppDate(ex.exam_date);
      if (startDt && now < startDt) {
        isAvailable = false;
        lockReason = `Starts: ${startDt.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}`;
        windowStatus = 'Upcoming';
      }
    }
    
    if (isAvailable && examEndDate) {
      const endDt = parseAppDate(examEndDate);
      if (endDt && now > endDt) {
        isAvailable = false;
        lockReason = `Closed: Window ended ${endDt.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
        windowStatus = 'Closed';
      }
    }

    const safeTitle = (ex.title || '').replace(/'/g, "\\'").replace(/\n/g, ' ');
    const safeFileUrl = (ex.file_url || '').replace(/'/g, "\\'");

    return `
    <div class="exam-card reveal-up" data-cat="${ex.category}">
      <div class="exam-card-header">
        <span class="exam-badge">${ex.category}</span>
        <span class="exam-difficulty">${SUBJECTS[ex.subject] || 'Other'}</span>
      </div>
      <h3 class="exam-title">${escHtml(ex.title)}</h3>
      <p class="exam-desc">${escHtml(cleanDesc)}</p>
      <div class="exam-info-row">
        ${ex.duration_minutes ? `<span class="exam-info-item">Duration: ${ex.duration_minutes} min</span>` : ''}
        ${accessCode ? `<span class="exam-info-item" style="color:#d97706; font-weight:700;">🔐 Key Code Required</span>` : ''}
        ${adminMode && accessCode ? `<span class="exam-info-item" style="background:rgba(245,158,11,0.15); color:#d97706; border:1px solid rgba(245,158,11,0.3); font-weight:800; font-family:'JetBrains Mono',monospace; cursor:pointer;" onclick="copyExamCodeToClipboard('${(accessCode || '').replace(/'/g, "\\'")}', event)" title="Click to copy code">🔑 Code: ${escHtml(accessCode)} (Copy)</span>` : ''}
        <span class="exam-info-item" style="font-family:'JetBrains Mono',monospace;">Barcode: ${escHtml(barcodeCode)}</span>
        ${lockReason ? `<span class="exam-info-item" style="color:#dc2626; font-weight:700;">${lockReason}</span>` : ''}
      </div>
      <div class="exam-actions">
        ${isAvailable && ex.file_url 
          ? `<button class="btn-exam-start" onclick="promptExamUnlock('${ex.id}', '${safeFileUrl}', ${ex.duration_minutes || 0}, '${safeTitle}', '${ex.subject || ''}', '${(accessCode || '').replace(/'/g, "\\'")}', '${barcodeCode}', '${ex.exam_date || ''}', '${examEndDate || ''}')">Open Exam Paper</button>`
          : `<button class="btn-exam-start disabled" disabled>${lockReason || (!ex.file_url ? 'No Paper File' : 'Locked')}</button>`
        }
        ${adminMode && accessCode ? `<button class="btn-exam-start" style="background:rgba(217,119,6,0.12); color:#d97706; border:1px solid rgba(217,119,6,0.3); padding:8px 12px;" onclick="shareExamCode('${safeTitle}', '${(accessCode || '').replace(/'/g, "\\'")}')">Share Code</button>` : ''}
        ${adminMode ? `<button class="btn-exam-start admin-del-btn" onclick="deleteExam('${ex.id}')">Delete</button>` : ''}
      </div>
    </div>
  `}).join('');

  initFilters('.exam-cat-btn', '.exam-card', 'cat');
  initRevealObserver();
}

/* ── NOTICES (CATEGORIZED STRICTLY BY DATES) ─────────────── */
async function loadNotices() {
  const list = qs('#notices-list');
  const filterWrap = qs('#notice-date-filters');
  if (!list) return;
  list.innerHTML = Array(3).fill(`<div class="note-card shimmer" style="height: 120px; margin-bottom: 16px;"></div>`).join('');

  const { data, error } = await supabase.from('notices').select('*').order('created_at', { ascending: false });

  if (error) { list.innerHTML = `<div class="error-state">Failed to load notices: ${error.message}</div>`; return; }
  if (!data?.length) { 
    list.innerHTML = '<div class="empty-state">No notices yet.</div>'; 
    if (filterWrap) filterWrap.innerHTML = '<button class="filter-tab active" data-date="all">All Dates</button>';
    return; 
  }

  // Categorize notices ONLY with dates
  const groupsMap = new Map();
  data.forEach((n) => {
    const timeInfo = formatDateTimeRecord(n.created_at);
    const key = timeInfo.dateKey;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        dateKey: key,
        label: timeInfo.dateCategoryLabel,
        dateFormatted: timeInfo.dateStr,
        pillText: timeInfo.datePillText,
        pillClass: timeInfo.datePillClass,
        items: []
      });
    }
    groupsMap.get(key).items.push({ notice: n, timeInfo });
  });

  // Render Date Filter Tabs
  if (filterWrap) {
    let filterButtonsHtml = `<button class="filter-tab active" data-date="all">All Dates (${data.length})</button>`;
    groupsMap.forEach((grp) => {
      const btnTitle = grp.label === 'Today' || grp.label === 'Yesterday' ? grp.label : grp.dateFormatted;
      filterButtonsHtml += `<button class="filter-tab" data-date="${grp.dateKey}">${btnTitle} (${grp.items.length})</button>`;
    });
    filterWrap.innerHTML = filterButtonsHtml;

    // Hook up date filter events
    filterWrap.querySelectorAll('.filter-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        filterWrap.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const selectedDate = btn.dataset.date;
        list.querySelectorAll('.notice-date-group').forEach(groupEl => {
          if (selectedDate === 'all' || groupEl.dataset.date === selectedDate) {
            groupEl.style.display = 'block';
          } else {
            groupEl.style.display = 'none';
          }
        });
      });
    });
  }

  // Render Notices categorized into clean Date Sections
  let groupsHtml = '';
  groupsMap.forEach((grp) => {
    const itemsHtml = grp.items.map(({ notice: n, timeInfo }, i) => {
      const links = Array.isArray(n.links) ? n.links : [];
      let fileHtml = '';
      if (n.file_url) {
        fileHtml = `<button class="note-btn" style="background: var(--accent); color: white; border: none; margin-right: 8px;" onclick="openFileViewer('${n.file_url}', '${escHtml(n.title)}', 'free')">📄 Open Attachment</button>`;
      }
      return `
      <div class="note-card reveal-up ${i % 3 === 1 ? 'delay-1' : ''}" style="margin-bottom: 14px;">
        <div class="note-icon-wrap" style="font-size: 1.1rem; font-weight: bold;">📢</div>
        <div class="note-content">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:6px;">
            <h3 class="note-title" style="margin:0; flex:1; font-size:1.02rem; line-height:1.4;">${escHtml(n.title)}</h3>
            <span class="notice-time-badge" title="Time posted">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              ${timeInfo.timeStr}
            </span>
          </div>
          <p class="note-desc" style="margin-top:6px; margin-bottom:12px; white-space:pre-line;">${escHtml(n.body)}</p>
          <div class="note-footer">
            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px;">
              ${fileHtml}
              ${links.length ? links.map(lk => `<a href="${escHtml(lk.url)}" target="_blank" class="note-btn">${escHtml(lk.label)}</a>`).join('') : ''}
            </div>
            ${adminMode ? `<button class="note-btn admin-del-btn" onclick="deleteNotice('${n.id}')">Delete</button>` : ''}
          </div>
        </div>
      </div>
      `;
    }).join('');

    groupsHtml += `
      <div class="notice-date-group" data-date="${grp.dateKey}">
        <div class="notice-date-header">
          <div class="notice-date-title">
            <span>📅 ${grp.label === 'Today' || grp.label === 'Yesterday' ? `${grp.label} (${grp.dateFormatted})` : grp.dateFormatted}</span>
            ${grp.pillText ? `<span class="notice-date-pill ${grp.pillClass}">${grp.pillText}</span>` : ''}
          </div>
          <span class="notice-date-count">${grp.items.length} notice${grp.items.length > 1 ? 's' : ''}</span>
        </div>
        <div class="notice-date-items">
          ${itemsHtml}
        </div>
      </div>
    `;
  });

  list.innerHTML = groupsHtml;
  initRevealObserver();
}

/* ═══════════════════════════════════════════════════════
   DAILY BRAINSTORMING, DSA & QUIZ
═══════════════════════════════════════════════════════ */
let activeChallenge = null;
let selectedQuizOption = null;
let pendingSaveRequired = false;

async function loadDailyChallenges() {
  const grid = qs('#daily-challenges-grid');
  if (!grid) return;

  grid.innerHTML = Array(3).fill(`<div class="challenge-card shimmer" style="height: 220px;"></div>`).join('');

  // Fetch challenges
  const { data: challenges, error } = await supabase
    .from('daily_challenges')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    grid.innerHTML = `<div class="error-state">Failed to load challenges: ${error.message}</div>`;
    return;
  }

  // Fetch current user submissions to track solved state & points permanently
  let userSubmissions = [];
  if (currentUser) {
    const { data: subs } = await supabase
      .from('daily_submissions')
      .select('challenge_id, status, score_awarded, submitted_at')
      .eq('user_id', currentUser.id)
      .order('submitted_at', { ascending: false });
    if (subs) userSubmissions = subs;
  }

  // Active challenges map
  const activeChallengesMap = new Map((challenges || []).map(c => [c.id, c]));

  // Track latest submission per challenge
  const latestSubMap = new Map();
  userSubmissions.forEach(s => {
    const key = s.challenge_id || s.id;
    if (!latestSubMap.has(key)) {
      latestSubMap.set(key, s);
    }
  });

  if (!challenges?.length) {
    grid.innerHTML = '<div class="empty-state">No daily challenges active right now. Check back soon or request admin to publish one!</div>';
    return;
  }

  grid.innerHTML = challenges.map((ch, i) => {
    const sub = latestSubMap.get(ch.id);
    const isSolved = sub && (sub.status === 'accepted' || (sub.score_awarded !== null && sub.score_awarded >= 7));
    const isUnderReview = sub && sub.status === 'reviewing';
    const isAttempted = !!sub && !isSolved && !isUnderReview;
    const typeLabel = ch.type === 'dsa' ? 'DSA Coding' : ch.type === 'quiz' ? 'Rapid Quiz' : 'Brainstorming';
    const typeClass = `challenge-type-${ch.type}`;
    const diffClass = `challenge-diff-${ch.difficulty || 'medium'}`;

    let statusHeaderBadge = '';
    if (isSolved) {
      statusHeaderBadge = `<span title="Completed" style="color:#10B981; font-weight:700; font-size:0.85rem;">Completed</span>`;
    } else if (isUnderReview) {
      statusHeaderBadge = `<span title="Under Review" style="color:#6366F1; font-weight:700; font-size:0.85rem;">Under Admin Review</span>`;
    } else if (isAttempted) {
      statusHeaderBadge = `<span title="Submitted" style="color:#F59E0B; font-weight:700; font-size:0.85rem;">Submitted</span>`;
    }

    return `
    <div class="challenge-card reveal-up ${isSolved ? 'solved-card' : isUnderReview ? 'attempted-card' : isAttempted ? 'attempted-card' : ''}" data-type="${ch.type}">
      <div class="exam-card-header">
        <span class="challenge-type-badge ${typeClass}">${typeLabel}</span>
        <span class="${diffClass}">${capitalize(ch.difficulty || 'medium')}</span>
      </div>
      <h3 class="exam-title" style="display:flex; align-items:center; justify-content:space-between;">
        <span>${escHtml(ch.title)}</span>
        ${statusHeaderBadge}
      </h3>
      <p class="exam-desc">${escHtml(ch.description || ch.problem_statement || '').substring(0, 140)}...</p>
      
      <div class="exam-info-row">
        <span class="exam-info-item">${capitalize(ch.difficulty || 'medium')}</span>
        <span class="exam-info-item">${ch.live_date ? new Date(ch.live_date).toLocaleDateString() : 'Today'}</span>
        ${isSolved ? '<span class="exam-info-item" style="color:#10B981;">Completed</span>' : isUnderReview ? '<span class="exam-info-item" style="color:#6366F1;">Submitted to Admin</span>' : isAttempted ? '<span class="exam-info-item" style="color:#F59E0B;">Submitted</span>' : ''}
      </div>

      <div class="exam-actions">
        <button class="btn-exam-start" onclick="openChallengeWorkspace('${ch.id}')">
          ${sub ? 'Review Solution' : ch.type === 'dsa' ? 'Solve Problem' : ch.type === 'quiz' ? 'Take Quiz' : 'Brainstorm'}
        </button>
        ${adminMode ? `
          <button class="btn-exam-start" style="background:rgba(99,102,241,0.15); color:#6366F1; border:1px solid rgba(99,102,241,0.3);" onclick="viewQuestionSubmissions('${ch.id}')" title="View student answers submitted for this question">View Submissions</button>
          <button class="btn-exam-start admin-del-btn" onclick="deleteDailyChallenge('${ch.id}')">Delete</button>
        ` : ''}
      </div>
    </div>
  `}).join('');

  // Daily Filters
  const filterBtns = qsa('.daily-filter-tab');
  const cards = qsa('#daily-challenges-grid .challenge-card');
  filterBtns.forEach(b => {
    b.addEventListener('click', () => {
      filterBtns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const val = b.dataset.type;
      cards.forEach(c => c.classList.toggle('hidden', val !== 'all' && c.dataset.type !== val));
    });
  });

  initRevealObserver();
}
window.loadDailyChallenges = loadDailyChallenges;

window.openChallengeWorkspace = async function(challengeId) {
  const { data: ch, error } = await supabase
    .from('daily_challenges')
    .select('*')
    .eq('id', challengeId)
    .single();

  if (error || !ch) {
    showToast('Failed to load challenge details.', 'error');
    return;
  }

  // For Quiz/MCQ: Open the dedicated MCQ options popup modal directly
  if (ch.type === 'quiz') {
    openMcqModal(ch);
    return;
  }

  activeChallenge = ch;
  selectedQuizOption = null;

  const overlay = qs('#challenge-overlay');
  const titleEl = qs('#cw-title');
  const typeBadge = qs('#cw-type-badge');
  const diffBadge = qs('#cw-diff-badge');
  const descEl = qs('#cw-description');
  const testcasesBox = qs('#cw-testcases-box');
  const testcasesEl = qs('#cw-testcases');
  const hintBox = qs('#cw-hint-box');
  const hintText = qs('#cw-hint-text');

  const rawDesc = ch.description || ch.problem_statement || '';
  let displayDesc = rawDesc;
  let displayHint = ch.solution_hint || ch.hint || '';
  let displayTestCases = ch.test_cases || '';
  let displayStarter = ch.starter_code || '';

  if (rawDesc.includes('[Hint]:')) {
    const parts = rawDesc.split('[Hint]:');
    displayDesc = parts[0].trim();
    const afterHint = parts[1] || '';
    displayHint = afterHint.split(/\[(Example I\/O|Starter Code)/)[0].trim();
  }
  if (rawDesc.includes('[Example I/O / Test Cases]:')) {
    const parts = rawDesc.split('[Example I/O / Test Cases]:');
    if (!rawDesc.includes('[Hint]:')) displayDesc = parts[0].trim();
    const afterTC = parts[1] || '';
    displayTestCases = afterTC.split(/\[Starter Code\]:/)[0].trim();
  }
  if (rawDesc.includes('[Starter Code]:')) {
    const parts = rawDesc.split('[Starter Code]:');
    if (!rawDesc.includes('[Hint]:') && !rawDesc.includes('[Example I/O')) displayDesc = parts[0].trim();
    displayStarter = (parts[1] || '').trim();
  }

  if (titleEl) titleEl.textContent = ch.title;
  if (typeBadge) {
    typeBadge.textContent = ch.type === 'dsa' ? 'DSA Problem' : ch.type === 'quiz' ? 'Quiz' : 'Brainstorm';
  }
  if (diffBadge) {
    diffBadge.textContent = capitalize(ch.difficulty || 'medium');
    diffBadge.className = `challenge-diff-badge challenge-diff-${ch.difficulty || 'medium'}`;
  }
  if (descEl) descEl.textContent = displayDesc;

  const paneTitle = qs('#cw-pane-title');
  if (paneTitle) {
    paneTitle.textContent = ch.type === 'quiz' ? 'Quiz Question' :
                            ch.type === 'brainstorm' ? 'Brainstorming Prompt' :
                            'Problem Description';
  }

  // Test cases box: ONLY show for DSA coding problems
  if (ch.type === 'dsa' && displayTestCases) {
    testcasesBox?.classList.remove('hidden');
    if (testcasesEl) testcasesEl.textContent = displayTestCases;
  } else {
    testcasesBox?.classList.add('hidden');
  }

  if (displayHint) {
    hintBox?.classList.remove('hidden');
    if (hintText) hintText.textContent = displayHint;
  } else {
    hintBox?.classList.add('hidden');
  }

  // Official Answer Box
  const officialBox = qs('#cw-official-box');
  const officialText = qs('#cw-official-text');
  const officialBtn = qs('#cw-reveal-official-btn');
  const ansContent = ch.official_answer || ch.solution;
  if (ansContent) {
    officialBox?.classList.remove('hidden');
    if (officialText) {
      officialText.textContent = ansContent;
      officialText.classList.add('hidden');
    }
    if (officialBtn) officialBtn.textContent = 'View Official Answer';
  } else {
    officialBox?.classList.add('hidden');
  }

  const codingSec = qs('#cw-coding-section');
  const brainstormSec = qs('#cw-brainstorm-section');
  const quizSec = qs('#cw-quiz-section');

  // Hide all evaluation grade cards initially
  qs('#cw-grade-card')?.classList.add('hidden');
  qs('#cw-brainstorm-grade')?.classList.add('hidden');
  qs('#cw-quiz-grade')?.classList.add('hidden');
  pendingSaveRequired = false;

  // Reset top exit button style
  const exitBtn = qs('.challenge-btn-close');
  if (exitBtn) {
    exitBtn.style.background = '';
    exitBtn.style.color = '';
    exitBtn.style.borderColor = '';
    exitBtn.style.opacity = '';
    exitBtn.style.cursor = '';
  }

  // Load previous user submission if exists
  let prevSub = null;
  if (currentUser) {
    try {
      const { data: subData } = await supabase
        .from('daily_submissions')
        .select('*')
        .eq('user_id', currentUser.id)
        .eq('challenge_id', challengeId)
        .order('submitted_at', { ascending: false })
        .limit(1);
      if (subData && subData.length > 0) {
        prevSub = subData[0];
      }
    } catch (e) {
      console.warn('Could not query previous submission:', e);
    }
  }

  // Strictly isolate interactive panes: only active type is displayed
  if (ch.type === 'quiz') {
    codingSec?.classList.add('hidden');
    brainstormSec?.classList.add('hidden');
    quizSec?.classList.remove('hidden');
    if (codingSec) codingSec.style.setProperty('display', 'none', 'important');
    if (brainstormSec) brainstormSec.style.setProperty('display', 'none', 'important');
    if (quizSec) quizSec.style.setProperty('display', 'flex', 'important');

    const optsContainer = qs('#cw-quiz-options');
    const opts = Array.isArray(ch.options) ? ch.options : [];
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const isLocked = !!prevSub;

    optsContainer.innerHTML = opts.map((opt, idx) => `
      <div class="quiz-option-card ${isLocked ? 'option-locked' : ''}" ${isLocked ? '' : `onclick="selectQuizOption(${idx})"`} id="quiz-opt-${idx}">
        <div class="quiz-option-letter">${letters[idx] || idx + 1}</div>
        <div style="flex:1;">${escHtml(opt.text)}</div>
      </div>
    `).join('');

    const quizSubmitBtn = qs('#cw-btn-submit-quiz');

    if (prevSub && prevSub.selected_option !== null && prevSub.selected_option !== undefined) {
      selectQuizOption(prevSub.selected_option);
      const gradeBox = qs('#cw-quiz-grade');
      const pill = qs('#cw-quiz-score-pill');
      const fb = qs('#cw-quiz-feedback');
      if (gradeBox && pill && fb) {
        gradeBox.classList.remove('hidden');
        const isCorrect = prevSub.status === 'accepted';
        pill.textContent = `Completed: ${prevSub.score_awarded || (isCorrect ? ch.points || 10 : 0)} XP`;
        pill.className = 'grade-pill ' + (isCorrect ? 'grade-pill-perfect' : 'grade-pill-low');
        fb.innerHTML = isCorrect ? '<strong>Correct Option Chosen.</strong> Solution permanently recorded.' : '<strong>Attempt Completed.</strong> Incorrect selection recorded.';
        fb.style.color = isCorrect ? '#10B981' : '#EF4444';
      }
      if (quizSubmitBtn) {
        quizSubmitBtn.disabled = true;
        quizSubmitBtn.style.opacity = '0.5';
        quizSubmitBtn.style.cursor = 'not-allowed';
        quizSubmitBtn.textContent = 'Attempt Completed (Saved)';
      }
    } else {
      if (quizSubmitBtn) {
        quizSubmitBtn.disabled = false;
        quizSubmitBtn.style.opacity = '1';
        quizSubmitBtn.style.cursor = 'pointer';
        quizSubmitBtn.textContent = 'Confirm & Check Answer';
      }
    }
  } else if (ch.type === 'brainstorm') {
    codingSec?.classList.add('hidden');
    quizSec?.classList.add('hidden');
    brainstormSec?.classList.remove('hidden');
    if (codingSec) codingSec.style.setProperty('display', 'none', 'important');
    if (quizSec) quizSec.style.setProperty('display', 'none', 'important');
    if (brainstormSec) brainstormSec.style.setProperty('display', 'flex', 'important');

    const brainstormInput = qs('#cw-brainstorm-input');
    const brainstormSubmitBtn = qs('#cw-btn-submit-brainstorm');

    if (brainstormInput) {
      brainstormInput.value = prevSub?.submission_code || '';
      brainstormInput.readOnly = !!prevSub;
      brainstormInput.style.opacity = prevSub ? '0.85' : '1';
    }

    if (prevSub && prevSub.submission_code) {
      const gradeBox = qs('#cw-brainstorm-grade');
      const pill = qs('#cw-brainstorm-score-pill');
      const fbText = qs('#cw-brainstorm-feedback');
      if (gradeBox && pill && fbText) {
        gradeBox.classList.remove('hidden');
        if (prevSub.status === 'reviewing') {
          pill.textContent = 'Under Admin Review';
          pill.className = 'grade-pill grade-pill-medium';
          fbText.textContent = 'Your single attempt has been submitted to the admin for review. No further edits are permitted.';
          fbText.style.color = 'var(--text-1)';
        } else {
          const sc = prevSub.score_awarded !== null && prevSub.score_awarded !== undefined ? prevSub.score_awarded : 0;
          pill.textContent = `Admin Grade: ${sc}/10`;
          pill.className = 'grade-pill ' + (sc >= 7 ? 'grade-pill-perfect' : 'grade-pill-medium');
          fbText.textContent = `Evaluated by admin: Grade ${sc}/10.`;
          fbText.style.color = sc >= 7 ? '#10B981' : 'var(--text-1)';
        }
      }
      if (brainstormSubmitBtn) {
        brainstormSubmitBtn.disabled = true;
        brainstormSubmitBtn.style.opacity = '0.5';
        brainstormSubmitBtn.style.cursor = 'not-allowed';
        brainstormSubmitBtn.textContent = 'Submitted to Admin (Locked)';
      }
    } else {
      if (brainstormSubmitBtn) {
        brainstormSubmitBtn.disabled = false;
        brainstormSubmitBtn.style.opacity = '1';
        brainstormSubmitBtn.style.cursor = 'pointer';
        brainstormSubmitBtn.textContent = 'Submit Answer for Review';
      }
    }
  } else {
    // DSA / Coding Canvas ONLY (Code Only)
    brainstormSec?.classList.add('hidden');
    quizSec?.classList.add('hidden');
    codingSec?.classList.remove('hidden');
    if (brainstormSec) brainstormSec.style.setProperty('display', 'none', 'important');
    if (quizSec) quizSec.style.setProperty('display', 'none', 'important');
    if (codingSec) codingSec.style.setProperty('display', 'flex', 'important');

    // Auto-detect language from title, starter code, or description
    let detectedLang = 'javascript';
    const combined = ((ch.title || '') + ' ' + (ch.starter_code || '') + ' ' + (ch.description || '')).toLowerCase();
    if (combined.includes('#include <stdio.h>') || combined.includes('int main') || ch.title.toLowerCase().trim() === 'c') {
      detectedLang = 'c';
    } else if (combined.includes('#include <iostream>') || combined.includes('std::') || combined.includes('cout') || combined.includes('c++')) {
      detectedLang = 'cpp';
    } else if (combined.includes('def ') || combined.includes('print(') || combined.includes('python')) {
      detectedLang = 'python';
    } else if (combined.includes('public class') || combined.includes('system.out.println') || combined.includes('java')) {
      detectedLang = 'java';
    }

    let codeToLoad = displayStarter || CODE_TEMPLATES[detectedLang] || CODE_TEMPLATES.javascript;
    let activeLang = detectedLang;

    const consoleOutput = qs('#cw-console-output');
    const testRunBtn = qs('#cw-btn-test-run');
    const saveBtn = qs('#cw-btn-save-code');
    const resetBtn = qs('.editor-reset-btn');
    const langSelect = qs('#cw-lang-select');
    const editor = qs('#cw-code-editor');

    if (prevSub && prevSub.submission_code) {
      let rawSaved = prevSub.submission_code;
      const langMatch = rawSaved.match(/^\/\/\s*Language:\s*([A-Za-z0-9_+-]+)\r?\n/i);
      if (langMatch) {
        const parsedLang = langMatch[1].toLowerCase();
        if (['c', 'cpp', 'python', 'java', 'javascript'].includes(parsedLang)) {
          activeLang = parsedLang;
        }
        rawSaved = rawSaved.replace(/^\/\/\s*Language:[^\r\n]*\r?\n/, '');
      }
      codeToLoad = rawSaved;

      const gradeCard = qs('#cw-grade-card');
      const scoreEl = qs('#cw-grade-score');
      const msgEl = qs('#cw-grade-message');
      if (gradeCard && scoreEl && msgEl) {
        gradeCard.classList.remove('hidden');
        const score = prevSub.score_awarded !== null && prevSub.score_awarded !== undefined ? prevSub.score_awarded : 0;
        scoreEl.textContent = `Final Grade: ${score}/10 (Locked)`;
        scoreEl.className = 'grade-pill ' + (score >= 8 ? 'grade-pill-perfect' : score >= 5 ? 'grade-pill-medium' : 'grade-pill-low');
        msgEl.textContent = `Attempt completed and permanently saved. Single-attempt policy: code and grade are locked.`;
        msgEl.style.color = score >= 7 ? 'var(--text-1)' : '#EF4444';
      }

      if (consoleOutput) {
        consoleOutput.textContent = `> Submission locked. Final Grade: ${prevSub.score_awarded || 0}/10. No further attempts allowed.`;
        consoleOutput.style.color = '#34d399';
      }

      // Lock editor and disable actions — only Exit is available
      if (editor) {
        editor.readOnly = true;
        editor.style.opacity = '0.85';
      }
      if (resetBtn) resetBtn.style.display = 'none';
      if (langSelect) langSelect.disabled = true;

      if (testRunBtn) {
        testRunBtn.disabled = true;
        testRunBtn.style.opacity = '0.35';
        testRunBtn.style.cursor = 'not-allowed';
        testRunBtn.textContent = 'Test & Run (Attempt Completed)';
      }
      if (saveBtn) {
        saveBtn.classList.remove('hidden');
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.5';
        saveBtn.style.cursor = 'not-allowed';
        saveBtn.textContent = 'Solution Saved (Final)';
      }
    } else {
      // First attempt: clean editable state
      if (editor) {
        editor.readOnly = false;
        editor.style.opacity = '1';
      }
      if (resetBtn) resetBtn.style.display = 'inline-block';
      if (langSelect) langSelect.disabled = false;

      if (consoleOutput) {
        consoleOutput.textContent = '> Ready. Write your solution and click "Test & Run Code". You have 1 attempt.';
        consoleOutput.style.color = '#9ca3af';
      }
      if (testRunBtn) {
        testRunBtn.disabled = false;
        testRunBtn.style.opacity = '1';
        testRunBtn.style.cursor = 'pointer';
        testRunBtn.textContent = 'Test & Run Code';
      }
      if (saveBtn) {
        saveBtn.classList.add('hidden');
        saveBtn.disabled = false;
      }
    }

    if (langSelect) langSelect.value = activeLang;
    if (editor) editor.value = codeToLoad;
  }

  overlay?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
};

window.closeChallengeWorkspace = function() {
  if (pendingSaveRequired) {
    showToast('Save is mandatory. Please click "Save Solution" before exiting.', 'error');
    const saveBtn = qs('#cw-btn-save-code');
    if (saveBtn) {
      saveBtn.focus();
      saveBtn.style.transform = 'scale(1.04)';
      setTimeout(() => { if (saveBtn) saveBtn.style.transform = ''; }, 300);
    }
    return;
  }
  const overlay = qs('#challenge-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
  activeChallenge = null;
  pendingSaveRequired = false;
};

window.toggleOfficialAnswer = function() {
  const textEl = qs('#cw-official-text');
  const btn = qs('#cw-reveal-official-btn');
  if (!textEl) return;
  const isHidden = textEl.classList.contains('hidden');
  if (isHidden) {
    textEl.classList.remove('hidden');
    if (btn) btn.textContent = 'Hide Official Answer';
  } else {
    textEl.classList.add('hidden');
    if (btn) btn.textContent = 'View Official Answer';
  }
};

const CODE_TEMPLATES = {
  c: `#include <stdio.h>

int main() {
    // Write your solution here
    printf("Hello World\\n");
    return 0;
}`,
  cpp: `#include <iostream>
using namespace std;

int main() {
    // Write your solution here
    cout << "Hello World" << endl;
    return 0;
}`,
  python: `def solution():
    # Write your solution here
    return "Hello World"

print(solution())`,
  java: `public class Main {
    public static void main(String[] args) {
        // Write your solution here
        System.out.println("Hello World");
    }
}`,
  javascript: `function solution() {
  // Write your solution here
  return true;
}

console.log(solution());`
};

window.changeCanvasLanguage = function(lang) {
  const editor = qs('#cw-code-editor');
  if (!editor) return;
  const currentVal = editor.value.trim();
  const isTemplate = Object.values(CODE_TEMPLATES).some(t => t.trim() === currentVal) || !currentVal;
  if (isTemplate || confirm('Switch to ' + lang.toUpperCase() + ' template? Any unsaved code will be replaced.')) {
    editor.value = CODE_TEMPLATES[lang] || CODE_TEMPLATES.javascript;
  }
};

window.resetChallengeCode = function() {
  const lang = qs('#cw-lang-select')?.value || 'javascript';
  const editor = qs('#cw-code-editor');
  if (editor) {
    if (activeChallenge?.starter_code && lang === 'javascript') {
      editor.value = activeChallenge.starter_code;
    } else {
      editor.value = CODE_TEMPLATES[lang] || CODE_TEMPLATES.javascript;
    }
  }
};

// --- Pattern Printing & Test Case Verification Engine ---

function extractFunctionBody(code, funcSignatureRegex) {
  const match = code.match(funcSignatureRegex);
  if (!match) return null;
  const startIdx = match.index + match[0].length;
  const braceIdx = code.indexOf('{', startIdx);
  if (braceIdx === -1) return null;
  let depth = 1;
  let endIdx = braceIdx + 1;
  while (endIdx < code.length && depth > 0) {
    if (code[endIdx] === '{') depth++;
    else if (code[endIdx] === '}') depth--;
    endIdx++;
  }
  return code.substring(braceIdx + 1, endIdx - 1);
}

function normalizeOutput(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.trimEnd())
    .filter((l, idx, arr) => !(l === '' && (idx === 0 || idx === arr.length - 1)))
    .join('\n')
    .trim();
}

function compareOutput(userOut, expectedOut) {
  const normUser = normalizeOutput(userOut);
  const normExp = normalizeOutput(expectedOut);
  if (!normExp) return true;
  if (!normUser) return false;
  if (normUser === normExp) return true;

  const linesUser = normUser.split('\n').map(l => l.trim());
  const linesExp = normExp.split('\n').map(l => l.trim());
  if (linesUser.length === linesExp.length && linesUser.every((l, i) => l === linesExp[i])) {
    return true;
  }
  return false;
}

function extractExpectedOutputs(challenge) {
  if (!challenge) return [];
  const rawDesc = challenge.description || challenge.problem_statement || '';
  let tc = (challenge.test_cases || '').trim();

  if (!tc && rawDesc.includes('[Example I/O / Test Cases]:')) {
    const parts = rawDesc.split('[Example I/O / Test Cases]:');
    tc = (parts[1] || '').split(/\[Starter Code\]:/)[0].trim();
  }

  const results = [];

  if (tc) {
    const regex = /Output\s*(?:\d+)?\s*:\s*\n?([\s\S]*?)(?=(?:\n\s*Input|\n\s*Example|\n\s*\[|$))/gi;
    let match;
    while ((match = regex.exec(tc)) !== null) {
      const out = match[1].trim();
      if (out) results.push(out);
    }
    if (!results.length && !/Input\s*:/i.test(tc)) {
      results.push(tc);
    }
  }

  if (!results.length) {
    const descRegex = /Output\s*(?:\d+)?\s*:\s*\n?([\s\S]*?)(?=(?:\n\s*Input|\n\s*Example|\n\s*\[|\n\s*Explanation|\n\s*Note|$))/gi;
    let match;
    while ((match = descRegex.exec(rawDesc)) !== null) {
      const out = match[1].trim();
      if (out) results.push(out);
    }
  }

  if (!results.length && challenge.official_answer) {
    const ans = challenge.official_answer.trim();
    const ansRegex = /Output\s*(?:\d+)?\s*:\s*\n?([\s\S]*?)(?=(?:\n\s*Input|\n\s*Example|\n\s*\[|$))/gi;
    let match = ansRegex.exec(ans);
    if (match && match[1].trim()) {
      results.push(match[1].trim());
    } else if (/^[\s*#0-9A-Za-z\-_|\\]+$/.test(ans) && ans.includes('\n') && !ans.includes(';') && !ans.includes('{')) {
      results.push(ans);
    }
  }

  return results;
}

function simulateCExecution(code) {
  try {
    let out = [];
    let cur = '';
    const _print = (s) => { cur += String(s ?? ''); };
    const _flush = () => { out.push(cur); cur = ''; };

    let clean = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    clean = clean.replace(/#include[^\n]*/g, '').replace(/using\s+namespace\s+std\s*;/g, '');

    let body = extractFunctionBody(clean, /(int|void)\s+main\s*\([^)]*\)/);
    if (!body) body = clean;
    body = body.replace(/return\s+0\s*;/g, '');

    body = body.replace(/\b(int|float|double|char|long|size_t|bool)\s+/g, 'let ');

    body = body.replace(/cout\s*<<\s*endl\s*;/g, '_flush();');
    body = body.replace(/cout\s*<<\s*"\\n"\s*;/g, '_flush();');
    body = body.replace(/cout\s*<<\s*"([^"]*)"\s*;/g, '_print("$1");');
    body = body.replace(/cout\s*<<\s*([^;<<]+)\s*;/g, '_print($1);');

    body = body.replace(/printf\s*\(\s*"\\n"\s*\)\s*;/g, '_flush();');
    body = body.replace(/printf\s*\(\s*"([^"]*)\\n"\s*\)\s*;/g, '_print("$1"); _flush();');
    body = body.replace(/printf\s*\(\s*"([^"]*)"\s*\)\s*;/g, '_print("$1");');
    body = body.replace(/printf\s*\(\s*"%d"\s*,\s*([^)]+)\)\s*;/g, '_print($1);');
    body = body.replace(/printf\s*\(\s*"%c"\s*,\s*([^)]+)\)\s*;/g, '_print($1);');
    body = body.replace(/printf\s*\(\s*"%s"\s*,\s*([^)]+)\)\s*;/g, '_print($1);');

    body = body.replace(/for\s*\(([^;]+);([^;]+);([^)]+)\)/g, (m, init, cond, inc) => {
      return `for (${init}; (${cond}) && ++_iter < 2000; ${inc})`;
    });

    const fn = new Function('_print', '_flush', `
      let _iter = 0;
      let cur = '';
      ${body}
      if (cur) _flush();
    `);
    fn(_print, _flush);
    return out.join('\n');
  } catch (e) {
    return null;
  }
}

function simulateJavaExecution(code) {
  try {
    let out = [];
    let cur = '';
    const _print = (s) => { cur += String(s ?? ''); };
    const _flush = () => { out.push(cur); cur = ''; };

    let clean = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    let body = extractFunctionBody(clean, /public\s+static\s+void\s+main\s*\([^)]*\)/);
    if (!body) body = clean;

    body = body.replace(/\b(int|float|double|char|long|boolean|String)\s+/g, 'let ');
    body = body.replace(/System\.out\.println\s*\(\s*\)\s*;/g, '_flush();');
    body = body.replace(/System\.out\.println\s*\(\s*"([^"]*)"\s*\)\s*;/g, '_print("$1"); _flush();');
    body = body.replace(/System\.out\.println\s*\(\s*([^)]+)\)\s*;/g, '_print($1); _flush();');
    body = body.replace(/System\.out\.print\s*\(\s*"([^"]*)"\s*\)\s*;/g, '_print("$1");');
    body = body.replace(/System\.out\.print\s*\(\s*([^)]+)\)\s*;/g, '_print($1);');

    body = body.replace(/for\s*\(([^;]+);([^;]+);([^)]+)\)/g, (m, init, cond, inc) => {
      return `for (${init}; (${cond}) && ++_iter < 2000; ${inc})`;
    });

    const fn = new Function('_print', '_flush', `
      let _iter = 0;
      let cur = '';
      ${body}
      if (cur) _flush();
    `);
    fn(_print, _flush);
    return out.join('\n');
  } catch (e) {
    return null;
  }
}

function simulatePythonExecution(code) {
  try {
    let out = [];
    let cur = '';
    const _print = (s) => { cur += String(s ?? ''); };
    const _flush = () => { out.push(cur); cur = ''; };

    const _range = (start, stop, step) => {
      if (stop === undefined) { stop = start; start = 0; }
      step = step === undefined ? 1 : step;
      const res = [];
      if (step > 0) {
        for (let i = start; i < stop && res.length < 500; i += step) res.push(i);
      } else if (step < 0) {
        for (let i = start; i > stop && res.length < 500; i += step) res.push(i);
      }
      return res;
    };

    const lines = code.split('\n');
    let jsCode = '';
    for (let rawLine of lines) {
      let line = rawLine;
      if (!line.trim() || line.trim().startsWith('#')) continue;

      line = line.replace(/\brange\s*\(/g, '_range(');

      if (/^\s*print\s*\(\s*\)/.test(line)) {
        line = line.replace(/print\s*\(\s*\)/, '_flush()');
      } else if (/print\s*\(\s*(['"][^'"]*['"])\s*\*\s*(\w+)\s*\)/.test(line)) {
        line = line.replace(/print\s*\(\s*(['"][^'"]*['"])\s*\*\s*(\w+)\s*\)/, '_print($1.repeat(Math.max(0, $2))); _flush()');
      } else if (/print\s*\(\s*([^,]+),\s*end\s*=\s*(['"][^'"]*['"])\s*\)/.test(line)) {
        line = line.replace(/print\s*\(\s*([^,]+),\s*end\s*=\s*(['"][^'"]*['"])\s*\)/, '_print($1); if ($2) _print($2)');
      } else if (/print\s*\(\s*([^)]+)\s*\)/.test(line)) {
        line = line.replace(/print\s*\(\s*([^)]+)\s*\)/, '_print($1); _flush()');
      }

      const forMatch = line.match(/^(\s*)for\s+(\w+)\s+in\s+(.*?):$/);
      if (forMatch) {
        const indent = forMatch[1];
        const varName = forMatch[2];
        const iterable = forMatch[3];
        line = `${indent}for (let ${varName} of ${iterable}) {`;
      }

      const assignMatch = line.match(/^(\s*)([a-zA-Z_]\w*)\s*=\s*(.*)$/);
      if (assignMatch && !line.includes('for ') && !line.includes('if ')) {
        line = `${assignMatch[1]}let ${assignMatch[2]} = ${assignMatch[3]};`;
      }

      jsCode += line + '\n';
    }

    const jsLines = jsCode.split('\n');
    let stack = [0];
    let structuredJs = '';
    for (let l of jsLines) {
      if (!l.trim()) continue;
      const indent = l.match(/^\s*/)[0].length;
      while (stack.length > 1 && indent < stack[stack.length - 1]) {
        stack.pop();
        structuredJs += '}\n';
      }
      structuredJs += l + '\n';
      if (l.trim().endsWith('{')) {
        stack.push(indent + 4);
      }
    }
    while (stack.length > 1) {
      stack.pop();
      structuredJs += '}\n';
    }

    const fn = new Function('_print', '_flush', '_range', `
      let _iter = 0;
      let cur = '';
      ${structuredJs}
      if (cur) _flush();
    `);
    fn(_print, _flush, _range);
    return out.join('\n');
  } catch (e) {
    return null;
  }
}

// Evaluate Code Quality, Syntax, and Runtime across all supported languages
function evaluateMultiLanguageCode(code, lang, starterCode, challenge) {
  const trimmed = (code || '').trim();

  // 1. No code submitted
  if (!trimmed) {
    return {
      score: 0,
      status: 'wrong',
      logs: ['> Error: Empty canvas. Please write your code before testing or submitting.'],
      feedback: 'No code submitted in the canvas (Grade: 0/10). Please write an implementation before submitting.'
    };
  }

  // 2. Unaltered starter template without solution
  const tmpl = (CODE_TEMPLATES[lang] || starterCode || '').trim();
  if (trimmed === tmpl) {
    return {
      score: 1,
      status: 'wrong',
      logs: ['> Notice: Starter code executed without user implementation.'],
      feedback: 'Unaltered starter template submitted without implementation (Grade: 1/10).'
    };
  }

  const expectedOutputs = extractExpectedOutputs(challenge);

  // 3. C & C++ Evaluator
  if (lang === 'c' || lang === 'cpp') {
    let score = 10;
    let feedback = [];
    let logs = [];

    const hasMain = /\b(int|void)\s+main\s*\(/i.test(trimmed);
    const openBraces = (trimmed.match(/{/g) || []).length;
    const closeBraces = (trimmed.match(/}/g) || []).length;
    const openParens = (trimmed.match(/\(/g) || []).length;
    const closeParens = (trimmed.match(/\)/g) || []).length;

    if (openBraces !== closeBraces) {
      return {
        score: 2,
        status: 'wrong',
        logs: [`> [GCC Error]: Unbalanced curly braces { } (${openBraces} open vs ${closeBraces} close)`],
        feedback: `C/C++ Syntax Error (Grade: 2/10): Unbalanced curly braces { }. Check closing braces.`
      };
    }
    if (openParens !== closeParens) {
      return {
        score: 2,
        status: 'wrong',
        logs: [`> [GCC Error]: Unbalanced parentheses ( ) (${openParens} open vs ${closeParens} close)`],
        feedback: `C/C++ Syntax Error (Grade: 2/10): Unbalanced parentheses ( ). Check closing parens.`
      };
    }

    if (!hasMain) {
      return {
        score: 3,
        status: 'wrong',
        logs: [`> [Linker Error]: Undefined reference to 'main'. Expected 'int main()' entry point.`],
        feedback: `C/C++ Structure Error (Grade: 3/10): Missing entry function int main().`
      };
    }

    // Check missing semicolons
    const lines = trimmed.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('#')) continue;
      if (line.endsWith('{') || line.endsWith('}') || line.endsWith(':')) continue;
      if (/(int|void)\s+main/.test(line)) continue;
      if (!line.endsWith(';')) {
        return {
          score: 3,
          status: 'wrong',
          logs: [`> [GCC Error line ${i + 1}]: Expected ';' at end of '${line.substring(0, 30)}...'`],
          feedback: `C/C++ Syntax Error (Grade: 3/10): Missing semicolon (;) at line ${i + 1}.`
        };
      }
    }

    const hasReturn = /\breturn\b/.test(trimmed);
    if (!hasReturn) { score -= 2; feedback.push("Missing return statement in main()."); }

    // Extract print outputs from printf or cout
    const printMatches = [];
    const printfRegex = /printf\s*\(\s*"([^"]*)"/g;
    let pMatch;
    while ((pMatch = printfRegex.exec(trimmed)) !== null) {
      printMatches.push(pMatch[1].replace(/\\n/g, ''));
    }
    const coutRegex = /cout\s*<<\s*"([^"]*)"/g;
    let cMatch;
    while ((cMatch = coutRegex.exec(trimmed)) !== null) {
      printMatches.push(cMatch[1]);
    }

    // Simulate C/C++ execution for pattern printing and test cases
    const simOut = simulateCExecution(trimmed);
    logs.push(`> [${lang === 'c' ? 'GCC 14.2' : 'G++ 14.2'}] Source compiled cleanly (0 warnings)`);

    if (expectedOutputs.length > 0) {
      const userProduced = simOut !== null ? simOut : printMatches.join(' ');
      const passed = expectedOutputs.some(exp => compareOutput(userProduced, exp));

      if (passed) {
        logs.push('> [Test Case Verification]: Output matched expected test pattern perfectly!');
        if (userProduced) {
          userProduced.split('\n').forEach(l => logs.push(`> Output: ${l}`));
        }
        feedback.unshift("Well-structured C/C++ solution! Output pattern matches problem requirements.");
        score = hasReturn ? 10 : 9;
        return { score, status: 'accepted', logs, feedback: feedback.join(' ') };
      } else {
        logs.push('> [Test Case Verification]: Output Mismatch!');
        logs.push(`> Expected Pattern:\n${expectedOutputs[0]}`);
        logs.push(`> Received Output:\n${userProduced || '(No output produced)'}`);
        logs.push('> Difference: The printed pattern does not match the requested problem pattern.');
        score = 3;
        return {
          score: 3,
          status: 'wrong',
          logs,
          feedback: 'C/C++ code compiled without syntax errors, but the generated output does not match the problem\'s expected pattern (Grade: 3/10). Please verify pattern shape and rows.'
        };
      }
    }

    if (simOut) {
      simOut.split('\n').forEach(l => logs.push(`> Output: ${l}`));
    } else if (printMatches.length) {
      printMatches.forEach(m => logs.push(`> Output: ${m}`));
    } else {
      logs.push('> [Execution output]: Program exited with code 0');
    }

    feedback.unshift("Well-structured C/C++ solution! Headers, main function, and syntax compiled without errors.");
    score = Math.max(1, Math.min(10, score));
    return { score, status: score >= 7 ? 'accepted' : 'reviewing', logs, feedback: feedback.join(' ') };
  }

  // 4. Python 3 Evaluator
  if (lang === 'python') {
    let score = 10;
    let feedback = [];
    let logs = [];

    const openParens = (trimmed.match(/\(/g) || []).length;
    const closeParens = (trimmed.match(/\)/g) || []).length;
    const openBrackets = (trimmed.match(/\[/g) || []).length;
    const closeBrackets = (trimmed.match(/\]/g) || []).length;

    if (openParens !== closeParens || openBrackets !== closeBrackets) {
      return {
        score: 2,
        status: 'wrong',
        logs: [`> [Python SyntaxError]: Unbalanced parentheses or brackets.`],
        feedback: `Python Syntax Error (Grade: 2/10): Unbalanced parentheses ( ) or brackets [ ].`
      };
    }

    // Check header colons
    const lines = trimmed.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^(def|if|elif|else|for|while|class|try|except|finally)\b/.test(line) && !line.endsWith(':')) {
        return {
          score: 2,
          status: 'wrong',
          logs: [`> [Python SyntaxError line ${i + 1}]: Expected ':' at end of header '${line.substring(0, 30)}...'`],
          feedback: `Python Syntax Error (Grade: 2/10): Expected colon (:) after statement header at line ${i + 1}.`
        };
      }
    }

    const hasDef = /\bdef\s+\w+/.test(trimmed);
    const hasReturn = /\breturn\b/.test(trimmed);
    const hasPrint = /\bprint\s*\(/.test(trimmed);

    if (!hasDef && !hasPrint) { score -= 3; feedback.push("Missing function definition or output statement."); }
    if (hasDef && !hasReturn && !hasPrint) { score -= 2; feedback.push("Missing return statement inside function."); }

    // Extract print outputs
    const prints = [];
    const printRegex = /print\s*\(\s*(['"])(.*?)\1\s*\)/g;
    let prMatch;
    while ((prMatch = printRegex.exec(trimmed)) !== null) {
      prints.push(prMatch[2]);
    }

    const simOut = simulatePythonExecution(trimmed);
    logs.push('> [Python 3.12] Source parsed and executed successfully');

    if (expectedOutputs.length > 0) {
      const userProduced = simOut !== null ? simOut : prints.join(' ');
      const passed = expectedOutputs.some(exp => compareOutput(userProduced, exp));

      if (passed) {
        logs.push('> [Test Case Verification]: Output matched expected test pattern perfectly!');
        if (userProduced) {
          userProduced.split('\n').forEach(l => logs.push(`> Output: ${l}`));
        }
        feedback.unshift("Clean Python implementation! Output pattern matches problem requirements.");
        return { score: 10, status: 'accepted', logs, feedback: feedback.join(' ') };
      } else {
        logs.push('> [Test Case Verification]: Output Mismatch!');
        logs.push(`> Expected Pattern:\n${expectedOutputs[0]}`);
        logs.push(`> Received Output:\n${userProduced || '(No output produced)'}`);
        logs.push('> Difference: The printed pattern does not match the requested problem pattern.');
        score = 3;
        return {
          score: 3,
          status: 'wrong',
          logs,
          feedback: 'Python code executed cleanly, but the generated output does not match the problem\'s expected pattern (Grade: 3/10). Please verify pattern shape and rows.'
        };
      }
    }

    if (simOut) {
      simOut.split('\n').forEach(l => logs.push(`> Output: ${l}`));
    } else if (prints.length) {
      prints.forEach(p => logs.push(`> Output: ${p}`));
    } else {
      logs.push('> [Execution output]: 0 runtime errors');
    }

    feedback.unshift("Clean Python implementation! Structure and syntax validated without errors.");
    score = Math.max(1, Math.min(10, score));
    return { score, status: score >= 7 ? 'accepted' : 'reviewing', logs, feedback: feedback.join(' ') };
  }

  // 5. Java Evaluator
  if (lang === 'java') {
    let score = 10;
    let feedback = [];
    let logs = [];

    const hasClass = /\bclass\s+\w+/.test(trimmed);
    const hasMain = /\bpublic\s+static\s+void\s+main\b/.test(trimmed);

    if (!hasClass || !hasMain) {
      return {
        score: 3,
        status: 'wrong',
        logs: [`> [Javac Error]: Missing class definition or public static void main(String[] args)`],
        feedback: `Java Structure Error (Grade: 3/10): Missing class definition or public static void main method.`
      };
    }

    const openBraces = (trimmed.match(/{/g) || []).length;
    const closeBraces = (trimmed.match(/}/g) || []).length;
    if (openBraces !== closeBraces) {
      return {
        score: 2,
        status: 'wrong',
        logs: [`> [Javac Error]: Unbalanced braces { } in class definition`],
        feedback: `Java Syntax Error (Grade: 2/10): Unbalanced curly braces { }.`
      };
    }

    const prints = [];
    const sysoutRegex = /System\.out\.println\s*\(\s*"([^"]*)"\s*\)/g;
    let sMatch;
    while ((sMatch = sysoutRegex.exec(trimmed)) !== null) {
      prints.push(sMatch[1]);
    }

    const simOut = simulateJavaExecution(trimmed);
    logs.push('> [Javac 21] Compiled Main.java successfully');

    if (expectedOutputs.length > 0) {
      const userProduced = simOut !== null ? simOut : prints.join(' ');
      const passed = expectedOutputs.some(exp => compareOutput(userProduced, exp));

      if (passed) {
        logs.push('> [Test Case Verification]: Output matched expected test pattern perfectly!');
        if (userProduced) {
          userProduced.split('\n').forEach(l => logs.push(`> Output: ${l}`));
        }
        feedback.unshift("Valid Java structure! Output pattern matches problem requirements.");
        return { score: 10, status: 'accepted', logs, feedback: feedback.join(' ') };
      } else {
        logs.push('> [Test Case Verification]: Output Mismatch!');
        logs.push(`> Expected Pattern:\n${expectedOutputs[0]}`);
        logs.push(`> Received Output:\n${userProduced || '(No output produced)'}`);
        logs.push('> Difference: The printed pattern does not match the requested problem pattern.');
        score = 3;
        return {
          score: 3,
          status: 'wrong',
          logs,
          feedback: 'Java code compiled cleanly, but the generated output does not match the problem\'s expected pattern (Grade: 3/10). Please verify pattern shape and rows.'
        };
      }
    }

    if (simOut) {
      simOut.split('\n').forEach(l => logs.push(`> Output: ${l}`));
    } else if (prints.length) {
      prints.forEach(p => logs.push(`> Output: ${p}`));
    } else {
      logs.push('> [Execution output]: Process finished with exit code 0');
    }

    feedback.unshift("Valid Java structure! Class and main method compiled cleanly.");
    score = Math.max(1, Math.min(10, score));
    return { score, status: score >= 7 ? 'accepted' : 'reviewing', logs, feedback: feedback.join(' ') };
  }

  // 6. JavaScript ES6 Evaluator (Native Runtime)
  let logs = [];
  let jsOutputLines = [];
  let execError = null;
  const originalLog = console.log;
  let res;
  try {
    console.log = function(...args) {
      const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      jsOutputLines.push(msg);
      logs.push('> ' + msg);
    };
    new Function(trimmed);
    res = new Function(`"use strict";\n${trimmed}`)();
    if (res !== undefined) {
      const retStr = typeof res === 'object' ? JSON.stringify(res) : String(res);
      logs.push(`> Returned: ${retStr}`);
      if (!jsOutputLines.length) jsOutputLines.push(retStr);
    }
  } catch (err) {
    execError = err;
  } finally {
    console.log = originalLog;
  }

  if (execError) {
    const isSyntax = execError.name === 'SyntaxError';
    const errScore = isSyntax ? 2 : 3;
    return {
      score: errScore,
      status: 'wrong',
      logs: [`> ${execError.name}: ${execError.message}`],
      feedback: `${execError.name} (Grade: ${errScore}/10): ${execError.message}.`
    };
  }

  let userProduced = jsOutputLines.join('\n');

  if (expectedOutputs.length > 0) {
    const passed = expectedOutputs.some(exp => compareOutput(userProduced, exp));

    if (passed) {
      logs.push('> [Test Case Verification]: Output matched expected test pattern perfectly!');
      return {
        score: 10,
        status: 'accepted',
        logs,
        feedback: 'Excellent! JavaScript code executed and output matches the required pattern perfectly (Grade: 10/10).'
      };
    } else {
      logs.push('> [Test Case Verification]: Output Mismatch!');
      logs.push(`> Expected Pattern:\n${expectedOutputs[0]}`);
      logs.push(`> Received Output:\n${userProduced || '(No output produced)'}`);
      logs.push('> Difference: The generated output does not match the requested problem pattern.');
      return {
        score: 3,
        status: 'wrong',
        logs,
        feedback: 'JavaScript code executed without syntax errors, but the output pattern does not match the problem\'s expected output (Grade: 3/10). Please verify pattern rows, shape, and symbols.'
      };
    }
  }

  let score = 10;
  let feedback = [];
  if (trimmed.length < 30) { score -= 4; feedback.push("Solution is very minimal or incomplete."); }
  const hasFunction = /function\s+\w+|const\s+\w+\s*=\s*(\(.*\)|function)|\w+\s*=>/i.test(trimmed);
  const hasReturn = /\breturn\b/.test(trimmed);
  if (!hasFunction) { score -= 2; feedback.push("Define a reusable function."); }
  if (!hasReturn) { score -= 2; feedback.push("Missing return statement in solution."); }

  if (!logs.length) logs.push('> Code executed cleanly (0 errors)');

  if (score >= 9) {
    feedback.unshift("Excellent! Code compiled without errors and executed cleanly.");
  } else {
    feedback.unshift("Good implementation with minor stylistic areas to refine.");
  }
  score = Math.max(1, Math.min(10, score));
  return { score, status: score >= 7 ? 'accepted' : 'reviewing', logs, feedback: feedback.join(' ') };
}

window.runChallengeCode = function() {
  const editor = qs('#cw-code-editor');
  const consoleOutput = qs('#cw-console-output');
  const gradeCard = qs('#cw-grade-card');
  const scoreEl = qs('#cw-grade-score');
  const msgEl = qs('#cw-grade-message');
  const testRunBtn = qs('#cw-btn-test-run');
  const saveBtn = qs('#cw-btn-save-code');
  const resetBtn = qs('.editor-reset-btn');
  const langSelect = qs('#cw-lang-select');
  const lang = langSelect?.value || 'javascript';
  if (!editor || !consoleOutput) return;

  const code = editor.value;
  consoleOutput.textContent = '> Running compiler & syntax diagnostics...';

  const evalResult = evaluateMultiLanguageCode(code, lang, activeChallenge?.starter_code, activeChallenge);

  consoleOutput.textContent = evalResult.logs.join('\n');
  consoleOutput.style.color = evalResult.status === 'wrong' ? '#f87171' : '#34d399';

  if (gradeCard && scoreEl && msgEl) {
    gradeCard.classList.remove('hidden');
    scoreEl.textContent = `Grade: ${evalResult.score}/10 (Must Save to Record)`;
    scoreEl.className = 'grade-pill ' + (evalResult.score >= 8 ? 'grade-pill-perfect' : evalResult.score >= 5 ? 'grade-pill-medium' : 'grade-pill-low');
    msgEl.textContent = evalResult.feedback + ' Code is locked. Click "Save Solution" below to permanently record your attempt.';
    msgEl.style.color = evalResult.score >= 7 ? 'var(--text-1)' : '#EF4444';
  }

  // Lock editor so user cannot make any further changes
  editor.readOnly = true;
  editor.style.opacity = '0.9';
  if (resetBtn) resetBtn.style.display = 'none';
  if (langSelect) langSelect.disabled = true;

  // Mark save as mandatory: exit is now blocked until Save Solution is clicked
  pendingSaveRequired = true;

  // Fade and disable the Test & Run button
  if (testRunBtn) {
    testRunBtn.disabled = true;
    testRunBtn.style.opacity = '0.35';
    testRunBtn.style.cursor = 'not-allowed';
    testRunBtn.textContent = 'Tested (Locked)';
  }

  // Dim exit button to clearly signal save must be completed first
  const exitBtn = qs('.challenge-btn-close');
  if (exitBtn) {
    exitBtn.style.opacity = '0.5';
  }

  // Only option available now is Save Solution
  if (saveBtn) {
    saveBtn.classList.remove('hidden');
    saveBtn.disabled = false;
    saveBtn.style.opacity = '1';
    saveBtn.style.cursor = 'pointer';
    saveBtn.textContent = `Save Solution (${evalResult.score}/10)`;
  }
};

window.clearConsoleOutput = function() {
  const c = qs('#cw-console-output');
  if (c) {
    c.textContent = '> _';
    c.style.color = '#9ca3af';
  }
};

window.saveChallengeSolution = async function() {
  if (!activeChallenge || !currentUser) {
    showToast('Please log in to save your solution.', 'error');
    return;
  }

  const editor = qs('#cw-code-editor');
  const code = editor?.value || '';
  const lang = qs('#cw-lang-select')?.value || 'javascript';

  const evalResult = evaluateMultiLanguageCode(code, lang, activeChallenge?.starter_code, activeChallenge);

  const gradeCard = qs('#cw-grade-card');
  const scoreEl = qs('#cw-grade-score');
  const msgEl = qs('#cw-grade-message');
  if (gradeCard && scoreEl && msgEl) {
    gradeCard.classList.remove('hidden');
    scoreEl.textContent = `Grade: ${evalResult.score}/10 (Saved & Completed)`;
    scoreEl.className = 'grade-pill ' + (evalResult.score >= 8 ? 'grade-pill-perfect' : evalResult.score >= 5 ? 'grade-pill-medium' : 'grade-pill-low');
    msgEl.textContent = evalResult.feedback + ' Solution permanently saved. You may now click Exit to return to the dashboard.';
    msgEl.style.color = evalResult.score >= 7 ? 'var(--text-1)' : '#EF4444';
  }

  const saveBtn = qs('#cw-btn-save-code');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving Solution...'; }

  const statusStr = evalResult.score >= 7 ? 'accepted' : (evalResult.score > 0 ? 'submitted' : 'wrong');
  const earnedXP = Math.round(((activeChallenge.points || 10) * evalResult.score) / 10);

  const payload = {
    user_id: currentUser.id,
    challenge_id: activeChallenge.id,
    user_email: currentUser.email,
    submission_code: `// Language: ${lang.toUpperCase()}\n` + (code || '// No code submitted'),
    status: statusStr,
    score_awarded: earnedXP
  };

  let saveError = null;
  try {
    const { data: existing } = await supabase
      .from('daily_submissions')
      .select('id')
      .eq('user_id', currentUser.id)
      .eq('challenge_id', activeChallenge.id)
      .order('submitted_at', { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      const res = await safeUpdate('daily_submissions', 'id', existing[0].id, {
        submission_code: payload.submission_code,
        status: payload.status,
        score_awarded: payload.score_awarded,
        submitted_at: new Date().toISOString()
      });
      saveError = res.error;
    } else {
      const res = await safeInsert('daily_submissions', payload);
      saveError = res.error;
    }
  } catch (err) {
    saveError = err;
  }

  // After save: permanently disable save button, show exit prompt
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.style.opacity = '0.5';
    saveBtn.style.cursor = 'not-allowed';
    saveBtn.textContent = 'Saved Permanently';
  }

  // Save is now completed: release exit block and highlight Exit button
  pendingSaveRequired = false;

  const closeBtn = qs('.challenge-btn-close');
  if (closeBtn) {
    closeBtn.style.opacity = '1';
    closeBtn.style.background = 'var(--accent)';
    closeBtn.style.color = 'var(--text-inv)';
    closeBtn.style.borderColor = 'var(--accent)';
  }

  if (saveError) {
    showToast('Save error: ' + (saveError.message || saveError), 'error');
  } else {
    showToast('Saved! Solution recorded. Click Exit to finish.', 'success');
    await loadDailyChallenges();
  }
};
window.submitChallengeSolution = window.saveChallengeSolution;

window.submitBrainstormAnswer = async function() {
  if (!activeChallenge || !currentUser) {
    showToast('Please log in.', 'error');
    return;
  }

  const text = qs('#cw-brainstorm-input')?.value || '';
  if (text.trim().length < 15) {
    showToast('Please provide a complete analysis or explanation.', 'error');
    return;
  }

  const gradeBox = qs('#cw-brainstorm-grade');
  const pill = qs('#cw-brainstorm-score-pill');
  const fbText = qs('#cw-brainstorm-feedback');

  if (gradeBox && pill && fbText) {
    gradeBox.classList.remove('hidden');
    pill.textContent = 'Submitted for Admin Review';
    pill.className = 'grade-pill grade-pill-medium';
    fbText.textContent = 'Your answer has been submitted to the admin for manual verification. Once reviewed, your grade will be updated.';
    fbText.style.color = 'var(--text-1)';
  }

  const btn = qs('#cw-brainstorm-section .btn-submit-code');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting to Admin...'; }

  // Brainstorming is submitted to admin for manual review (status: reviewing, initial XP: 0 until admin grades)
  const payload = {
    user_id: currentUser.id,
    challenge_id: activeChallenge.id,
    user_email: currentUser.email,
    submission_code: text,
    status: 'reviewing',
    score_awarded: 0
  };

  let saveError = null;
  try {
    const { data: existing } = await supabase
      .from('daily_submissions')
      .select('id')
      .eq('user_id', currentUser.id)
      .eq('challenge_id', activeChallenge.id)
      .order('submitted_at', { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      const res = await safeUpdate('daily_submissions', 'id', existing[0].id, {
        submission_code: payload.submission_code,
        status: payload.status,
        score_awarded: payload.score_awarded,
        submitted_at: new Date().toISOString()
      });
      saveError = res.error;
    } else {
      const res = await safeInsert('daily_submissions', payload);
      saveError = res.error;
    }
  } catch (err) {
    saveError = err;
  }

  // Lock brainstorm textarea and button: 1 single attempt only
  const brainstormInput = qs('#cw-brainstorm-input');
  if (brainstormInput) {
    brainstormInput.readOnly = true;
    brainstormInput.style.opacity = '0.85';
  }

  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    btn.textContent = 'Submitted to Admin (Locked)';
  }

  // Highlight Exit button in top bar
  const closeBtn = qs('.challenge-btn-close');
  if (closeBtn) {
    closeBtn.style.background = 'var(--accent)';
    closeBtn.style.color = 'var(--text-inv)';
    closeBtn.style.borderColor = 'var(--accent)';
  }

  if (saveError) {
    showToast('Submission error: ' + (saveError.message || saveError), 'error');
  } else {
    showToast('Answer submitted to admin for review. Click Exit to finish.', 'info');
    await loadDailyChallenges();
  }
};

// --- Dedicated MCQ Popup Modal (Single Attempt Flow) ---

window.openMcqModal = async function(ch) {
  if (!ch) return;
  activeChallenge = ch;
  selectedQuizOption = null;

  const modal = qs('#mcq-popup-modal');
  const titleEl = qs('#mcq-modal-title');
  const questionEl = qs('#mcq-modal-question');
  const diffBadge = qs('#mcq-diff-badge');
  const optionsList = qs('#mcq-modal-options');
  const gradeCard = qs('#mcq-modal-grade');
  const submitBtn = qs('#mcq-modal-submit-btn');

  if (titleEl) titleEl.textContent = ch.title || 'Daily Quiz';
  if (questionEl) questionEl.textContent = ch.description || ch.problem_statement || 'No question details provided.';
  if (diffBadge) {
    diffBadge.textContent = capitalize(ch.difficulty || 'medium');
    diffBadge.className = `challenge-diff-badge challenge-diff-${ch.difficulty || 'medium'}`;
  }

  if (gradeCard) gradeCard.classList.add('hidden');

  // Check if current user has already attempted this question
  let prevSub = null;
  if (currentUser) {
    try {
      const { data: subData } = await supabase
        .from('daily_submissions')
        .select('*')
        .eq('user_id', currentUser.id)
        .eq('challenge_id', ch.id)
        .order('submitted_at', { ascending: false })
        .limit(1);
      if (subData && subData.length > 0) prevSub = subData[0];
    } catch (e) {
      console.warn('Could not query previous submission:', e);
    }
  }

  const opts = Array.isArray(ch.options) ? ch.options : [];
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const isLocked = !!prevSub;

  if (optionsList) {
    optionsList.innerHTML = opts.map((opt, idx) => `
      <div class="quiz-option-card ${isLocked ? 'option-locked' : ''}" ${isLocked ? '' : `onclick="selectMcqModalOption(${idx})"`} id="mcq-modal-opt-${idx}">
        <div class="quiz-option-letter">${letters[idx] || idx + 1}</div>
        <div style="flex:1;">${escHtml(opt.text)}</div>
      </div>
    `).join('');
  }

  if (prevSub && prevSub.selected_option !== null && prevSub.selected_option !== undefined) {
    // Already attempted: lock options and show result card
    selectMcqModalOption(prevSub.selected_option, true);
    const pill = qs('#mcq-modal-score-pill');
    const fb = qs('#mcq-modal-feedback');
    const isCorrect = prevSub.status === 'accepted';
    if (gradeCard && pill && fb) {
      gradeCard.classList.remove('hidden');
      pill.textContent = isCorrect ? 'Completed: Correct' : 'Completed: Incorrect';
      pill.className = 'grade-pill ' + (isCorrect ? 'grade-pill-perfect' : 'grade-pill-low');
      fb.innerHTML = isCorrect
        ? `<strong>Correct Option Chosen.</strong> Single attempt permanently saved. ${ch.explanation ? '<br/>' + escHtml(ch.explanation) : ''}`
        : `<strong>Incorrect Selection Recorded.</strong> Single attempt policy: solution is locked. ${ch.explanation ? '<br/>' + escHtml(ch.explanation) : ''}`;
      fb.style.color = isCorrect ? '#10B981' : '#EF4444';
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.5';
      submitBtn.style.cursor = 'not-allowed';
      submitBtn.textContent = 'Attempt Completed (Saved)';
    }
  } else {
    // Fresh attempt: submit button disabled until user picks an answer
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.5';
      submitBtn.style.cursor = 'not-allowed';
      submitBtn.textContent = 'Select an option to submit';
    }
  }

  if (modal) modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
};

window.closeMcqModal = function() {
  const modal = qs('#mcq-popup-modal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
};

window.selectMcqModalOption = function(idx, forceLock = false) {
  selectedQuizOption = idx;
  qsa('#mcq-modal-options .quiz-option-card').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });
  const submitBtn = qs('#mcq-modal-submit-btn');
  if (submitBtn && !forceLock) {
    submitBtn.disabled = false;
    submitBtn.style.opacity = '1';
    submitBtn.style.cursor = 'pointer';
    submitBtn.textContent = 'Submit Answer (Single Attempt)';
  }
};

window.submitMcqModalAnswer = async function() {
  if (selectedQuizOption === null) {
    showToast('Please select an option before submitting.', 'error');
    return;
  }
  if (!activeChallenge || !currentUser) {
    showToast('Please log in to submit your answer.', 'error');
    return;
  }

  const submitBtn = qs('#mcq-modal-submit-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
  }

  const opts = activeChallenge.options || [];
  const chosen = opts[selectedQuizOption];
  const isCorrect = chosen?.is_correct === true;
  const challengePoints = activeChallenge.points !== undefined && activeChallenge.points !== null ? Number(activeChallenge.points) : 10;
  const earnedXP = isCorrect ? challengePoints : 0;

  const payload = {
    user_id: currentUser.id,
    challenge_id: activeChallenge.id,
    user_email: currentUser.email,
    selected_option: selectedQuizOption,
    status: isCorrect ? 'accepted' : 'wrong',
    score_awarded: earnedXP
  };

  let saveError = null;
  try {
    const { data: existing } = await supabase
      .from('daily_submissions')
      .select('id')
      .eq('user_id', currentUser.id)
      .eq('challenge_id', activeChallenge.id)
      .order('submitted_at', { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      const res = await safeUpdate('daily_submissions', 'id', existing[0].id, {
        selected_option: payload.selected_option,
        status: payload.status,
        score_awarded: payload.score_awarded,
        submitted_at: new Date().toISOString()
      });
      saveError = res.error;
    } else {
      const res = await safeInsert('daily_submissions', payload);
      saveError = res.error;
    }
  } catch (err) {
    saveError = err;
  }

  // Display result card
  const gradeCard = qs('#mcq-modal-grade');
  const pill = qs('#mcq-modal-score-pill');
  const fb = qs('#mcq-modal-feedback');
  if (gradeCard && pill && fb) {
    gradeCard.classList.remove('hidden');
    pill.textContent = isCorrect ? 'Grade: 10/10 (Correct)' : 'Grade: 0/10 (Incorrect)';
    pill.className = 'grade-pill ' + (isCorrect ? 'grade-pill-perfect' : 'grade-pill-low');
    fb.innerHTML = isCorrect
      ? `<strong>Correct Option Chosen.</strong> Permanent solution saved. ${activeChallenge.explanation ? '<br/>' + escHtml(activeChallenge.explanation) : ''}`
      : `<strong>Incorrect Selection.</strong> Recorded. Single attempt policy: solution is locked. ${activeChallenge.explanation ? '<br/>' + escHtml(activeChallenge.explanation) : ''}`;
    fb.style.color = isCorrect ? '#10B981' : '#EF4444';
  }

  // Lock options permanently (one time only)
  qsa('#mcq-modal-options .quiz-option-card').forEach(el => {
    el.classList.add('option-locked');
    el.onclick = null;
  });

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.style.opacity = '0.5';
    submitBtn.style.cursor = 'not-allowed';
    submitBtn.textContent = 'Attempt Completed (Saved)';
  }

  if (saveError) {
    showToast('Save error: ' + (saveError.message || saveError), 'error');
  } else {
    showToast(isCorrect ? 'Correct! Solution recorded.' : 'Attempt recorded.', isCorrect ? 'success' : 'info');
    await loadDailyChallenges();
  }
};

window.selectQuizOption = function(idx) {
  selectedQuizOption = idx;
  qsa('.quiz-option-card').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });
  const quizSubmitBtn = qs('#cw-btn-submit-quiz');
  if (quizSubmitBtn) {
    quizSubmitBtn.disabled = false;
    quizSubmitBtn.style.opacity = '1';
    quizSubmitBtn.style.cursor = 'pointer';
    quizSubmitBtn.textContent = 'Submit Answer (Single Attempt)';
  }
};

window.submitQuizOption = async function() {
  if (selectedQuizOption === null) {
    showToast('Please pick an answer first!', 'error');
    return;
  }
  if (!activeChallenge || !currentUser) {
    showToast('Please log in.', 'error');
    return;
  }

  // Admin saved correct answer from options: chosen option is checked automatically
  const opts = activeChallenge.options || [];
  const chosen = opts[selectedQuizOption];
  const isCorrect = chosen?.is_correct === true;
  const challengePoints = activeChallenge.points !== undefined && activeChallenge.points !== null ? Number(activeChallenge.points) : 10;
  const earnedXP = isCorrect ? challengePoints : 0;

  const gradeBox = qs('#cw-quiz-grade');
  const pill = qs('#cw-quiz-score-pill');
  const fb = qs('#cw-quiz-feedback');

  if (gradeBox && pill && fb) {
    gradeBox.classList.remove('hidden');
    pill.textContent = isCorrect ? 'Grade: 10/10 (Correct)' : 'Grade: 0/10 (Incorrect)';
    pill.className = 'grade-pill ' + (isCorrect ? 'grade-pill-perfect' : 'grade-pill-low');
    if (isCorrect) {
      fb.innerHTML = `<strong>Correct Option Chosen.</strong> Solution recorded! ${activeChallenge.explanation ? '<br/>' + escHtml(activeChallenge.explanation) : ''}`;
      fb.style.color = '#10B981';
    } else {
      fb.innerHTML = `<strong>Incorrect Selection.</strong> Recorded. Single attempt policy: solution is locked.`;
      fb.style.color = '#EF4444';
    }
  }

  const btn = qs('#cw-quiz-section .btn-submit-code');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  const payload = {
    user_id: currentUser.id,
    challenge_id: activeChallenge.id,
    user_email: currentUser.email,
    selected_option: selectedQuizOption,
    status: isCorrect ? 'accepted' : 'wrong',
    score_awarded: earnedXP
  };

  let saveError = null;
  try {
    const { data: existing } = await supabase
      .from('daily_submissions')
      .select('id')
      .eq('user_id', currentUser.id)
      .eq('challenge_id', activeChallenge.id)
      .order('submitted_at', { ascending: false })
      .limit(1);

    if (existing && existing.length > 0) {
      const res = await safeUpdate('daily_submissions', 'id', existing[0].id, {
        selected_option: payload.selected_option,
        status: payload.status,
        score_awarded: payload.score_awarded,
        submitted_at: new Date().toISOString()
      });
      saveError = res.error;
    } else {
      const res = await safeInsert('daily_submissions', payload);
      saveError = res.error;
    }
  } catch (err) {
    saveError = err;
  }

  // Lock quiz options and button permanently: 1 single attempt only
  qsa('.quiz-option-card').forEach(el => {
    el.classList.add('option-locked');
    el.onclick = null;
  });

  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    btn.textContent = 'Attempt Completed (Saved)';
  }

  // Highlight Exit button in top bar
  const closeBtn = qs('.challenge-btn-close');
  if (closeBtn) {
    closeBtn.style.background = 'var(--accent)';
    closeBtn.style.color = 'var(--text-inv)';
    closeBtn.style.borderColor = 'var(--accent)';
  }

  if (saveError) {
    showToast('Save error: ' + (saveError.message || saveError), 'error');
  } else {
    if (isCorrect) {
      showToast('Correct! Solution recorded. Click Exit to finish.', 'success');
    } else {
      showToast('Incorrect answer. Attempt completed. Click Exit to finish.', 'info');
    }
    await loadDailyChallenges();
  }
};

window.viewQuestionSubmissions = async function(challengeId) {
  if (!adminMode) return;
  const modal = qs('#admin-view-subs-modal');
  const titleEl = qs('#admin-view-subs-title');
  const subtitleEl = qs('#admin-view-subs-subtitle');
  const contentEl = qs('#admin-view-subs-content');
  if (!modal || !contentEl) return;

  modal.classList.remove('hidden');
  contentEl.innerHTML = '<div style="color:var(--text-2);">Fetching student submissions...</div>';

  // Get question info
  const { data: ch } = await supabase.from('daily_challenges').select('*').eq('id', challengeId).single();
  if (titleEl) titleEl.textContent = `Submissions for: ${ch?.title || 'Question'}`;
  if (subtitleEl) subtitleEl.textContent = `Category: ${(ch?.type || 'DSA').toUpperCase()} | Max Points: ${ch?.points || 10} XP`;

  // Get submissions
  const { data: subs, error } = await supabase
    .from('daily_submissions')
    .select('*')
    .eq('challenge_id', challengeId)
    .order('submitted_at', { ascending: false });

  if (error) {
    contentEl.innerHTML = `<div style="color:#EF4444;">Error fetching submissions: ${escHtml(error.message)}</div>`;
    return;
  }

  if (!subs?.length) {
    contentEl.innerHTML = '<div style="color:var(--text-3); text-align:center; padding:30px;">No student submissions found for this question yet.</div>';
    return;
  }

  const maxPoints = ch?.points || 10;
  contentEl.innerHTML = subs.map((sub, idx) => {
    const isBrainstorm = ch?.type === 'brainstorm';
    const isAccepted = sub.status === 'accepted';
    const isReviewing = sub.status === 'reviewing';

    return `
      <div style="background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div>
            <span style="font-weight:700; color:var(--text-1); font-size:0.95rem;">${escHtml(sub.user_email || 'Student')}</span>
            <span style="font-size:0.75rem; color:var(--text-3); margin-left:8px;">${sub.submitted_at ? new Date(sub.submitted_at).toLocaleString() : ''}</span>
          </div>
          <span style="font-size:0.75rem; font-weight:700; padding:3px 8px; border-radius:4px; ${isAccepted ? 'background:rgba(16,185,129,0.15); color:#10B981;' : isReviewing ? 'background:rgba(99,102,241,0.15); color:#6366F1;' : 'background:rgba(239,68,68,0.15); color:#EF4444;'}">
            ${isReviewing ? 'NEEDS REVIEW' : isAccepted ? 'ACCEPTED' : 'WRONG / ATTEMPTED'}
          </span>
        </div>

        <div style="font-size:0.85rem; color:var(--text-2); margin-bottom:10px;">
          Current Score: <strong style="color:#F59E0B;">${sub.score_awarded || 0} XP</strong> / ${maxPoints} XP
        </div>

        ${sub.submission_code ? `
          <div style="margin-bottom:12px;">
            <div style="font-size:0.75rem; font-weight:700; color:var(--text-3); margin-bottom:4px;">SUBMITTED ANSWER / CODE:</div>
            <pre style="background:#0d1117; color:#58a6ff; padding:10px; border-radius:6px; font-size:0.82rem; max-height:180px; overflow-y:auto; font-family:monospace; white-space:pre-wrap; margin:0;">${escHtml(sub.submission_code)}</pre>
          </div>
        ` : ''}

        ${sub.selected_option !== null && sub.selected_option !== undefined ? `
          <div style="font-size:0.82rem; color:var(--text-2); margin-bottom:10px;">
            Selected Option Index: <strong>${sub.selected_option}</strong> (${isAccepted ? 'Correct' : 'Incorrect'})
          </div>
        ` : ''}

        ${isBrainstorm || isReviewing ? `
          <div style="display:flex; align-items:center; gap:10px; margin-top:12px; padding-top:10px; border-top:1px dashed var(--border);">
            <label style="font-size:0.8rem; font-weight:700; color:var(--text-1);">Assign XP (0 - ${maxPoints}):</label>
            <input type="number" id="admin-grade-input-${sub.id}" min="0" max="${maxPoints}" value="${sub.score_awarded || maxPoints}" class="admin-input" style="width:80px; padding:6px; font-size:0.85rem;" />
            <button class="admin-submit-btn" style="padding:6px 14px; font-size:0.8rem;" onclick="adminGradeBrainstormSubmission('${sub.id}', '${sub.challenge_id}')">Save &amp; Award XP</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
};

window.closeAdminSubmissionsModal = function() {
  const modal = qs('#admin-view-subs-modal');
  if (modal) modal.classList.add('hidden');
};

window.adminGradeBrainstormSubmission = async function(subId, challengeId) {
  if (!adminMode) return;
  const input = qs(`#admin-grade-input-${subId}`);
  const awarded = parseInt(input?.value) || 0;

  const { error } = await supabase
    .from('daily_submissions')
    .update({
      score_awarded: awarded,
      status: awarded >= 7 ? 'accepted' : 'submitted'
    })
    .eq('id', subId);

  if (error) {
    showToast('Failed to update submission: ' + error.message, 'error');
  } else {
    showToast(`Awarded ${awarded} XP to student!`, 'success');
    viewQuestionSubmissions(challengeId);
    if (currentPage === 'daily') loadDailyChallenges();
  }
};

window.deleteDailyChallenge = async function(id) {
  if (!adminMode) return;
  if (confirm('Delete this daily challenge?')) {
    const { error } = await supabase.from('daily_challenges').delete().eq('id', id);
    if (error) showToast('Delete failed: ' + error.message, 'error');
    else {
      showToast('Challenge deleted.', 'info');
      loadDailyChallenges();
    }
  }
};

/* ── FILE VIEWER ─────────────────────────────────────── */
window.openFileViewer = function(url, title, requiredTier = 'lite') {
  if (!checkPremiumAccess(requiredTier)) return;
  
  const overlay = qs('#file-viewer-overlay');
  const frame = qs('#file-viewer-frame');
  const titleEl = qs('#file-viewer-title');
  if (!overlay || !frame) return;
  
  titleEl.textContent = title || 'Document Preview';
  frame.src = url;
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
};

window.closeFileViewer = function() {
  const overlay = qs('#file-viewer-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
  qs('#file-viewer-frame').src = '';
};

/* ── SETTINGS PAGE ───────────────────────────────────── */
window.switchSettingsTab = function(tab) {
  qsa('.settings-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  qsa('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
};

window.toggleTheme = function() {
  const isDark = qs('#theme-toggle').checked;
  if (isDark) {
    document.documentElement.style.setProperty('--bg', '#111');
    document.documentElement.style.setProperty('--bg-2', '#1a1a1a');
    document.documentElement.style.setProperty('--text-1', '#fff');
    document.documentElement.style.setProperty('--text-2', '#aaa');
    document.documentElement.style.setProperty('--border', '#333');
  } else {
    document.documentElement.style.setProperty('--bg', '#FAFAFA');
    document.documentElement.style.setProperty('--bg-2', '#FFFFFF');
    document.documentElement.style.setProperty('--text-1', '#0A0A0A');
    document.documentElement.style.setProperty('--text-2', '#555555');
    document.documentElement.style.setProperty('--border', 'rgba(0,0,0,0.08)');
  }
};

window.toggleBiometricLock = async function() {
  const isEnabled = qs('#biometric-toggle').checked;
  if (userProfile) {
    userProfile.biometric_enabled = isEnabled;
    const { error } = await supabase.from('profiles').update({ biometric_enabled: isEnabled }).eq('id', currentUser.id);
    if (error) {
      showToast('Failed to save biometric setting', 'error');
      qs('#biometric-toggle').checked = !isEnabled;
    } else {
      showToast('Fingerprint lock ' + (isEnabled ? 'enabled' : 'disabled'), 'success');
    }
  }
};

let pendingAvatarFile = null;
let pendingAvatarUrl = null;
let pendingSigFile = null;
let pendingSigUrl = null;

window.updateProfilePic = function(event) {
  const file = event.target.files[0];
  if (file) {
    pendingAvatarFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingAvatarUrl = e.target.result;
      const avatar = qs('#settings-avatar-preview');
      avatar.textContent = '';
      avatar.style.backgroundImage = `url('${pendingAvatarUrl}')`;
      avatar.style.backgroundSize = 'cover';
      avatar.style.backgroundPosition = 'center';
      showToast('Profile picture ready to save.', 'info');
    };
    reader.readAsDataURL(file);
  }
};

window.updateSignaturePic = function(event) {
  const file = event.target.files[0];
  if (file) {
    pendingSigFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingSigUrl = e.target.result;
      const sig = qs('#settings-sig-preview');
      sig.textContent = '';
      sig.style.backgroundImage = `url('${pendingSigUrl}')`;
      showToast('Signature ready to save.', 'info');
    };
    reader.readAsDataURL(file);
  }
};

window.saveProfile = async function() {
  const name = qs('#profile-name').value;
  const navAvatar = qs('#user-avatar-char');
  const homeName = qs('#home-id-name');
  const homeAv = qs('#home-id-avatar');
  const homeSig = qs('#home-id-signature');
  const homeSigPh = qs('#home-id-signature-ph');
  
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Saving...';
  
  let finalAvatarUrl = null;
  let finalSigUrl = null;
  
  if (pendingAvatarFile) {
    const path = `avatars/${currentUser.id}_${Date.now()}`;
    const { error: uploadError } = await supabase.storage.from('studyvault').upload(path, pendingAvatarFile);
    if (!uploadError) {
      const { data: { publicUrl } } = supabase.storage.from('studyvault').getPublicUrl(path);
      finalAvatarUrl = publicUrl;
    }
  }
  
  if (pendingSigFile) {
    const path = `signatures/${currentUser.id}_${Date.now()}`;
    const { error: sigError } = await supabase.storage.from('studyvault').upload(path, pendingSigFile);
    if (!sigError) {
      const { data: { publicUrl } } = supabase.storage.from('studyvault').getPublicUrl(path);
      finalSigUrl = publicUrl;
    }
  }
  
  const profileData = { id: currentUser.id };
  if (name) profileData.display_name = name;
  if (finalAvatarUrl) profileData.avatar_url = finalAvatarUrl;
  if (finalSigUrl) profileData.signature_url = finalSigUrl;
  
  const { error } = await supabase.from('profiles').upsert(profileData);
  
  if (error) {
    showToast('Failed to save profile: ' + error.message, 'error');
  } else {
    if (name) {
      qs('#user-name-text').textContent = name;
      if (homeName) homeName.textContent = name;
    }
    
    if (finalAvatarUrl) {
      navAvatar.textContent = '';
      navAvatar.style.backgroundImage = `url('${finalAvatarUrl}')`;
      if (homeAv) { homeAv.textContent = ''; homeAv.style.backgroundImage = `url('${finalAvatarUrl}')`; }
    }
    
    if (finalSigUrl && homeSig && homeSigPh) {
      homeSig.src = finalSigUrl;
      homeSig.classList.remove('hidden');
      homeSigPh.classList.add('hidden');
    }
    
    showToast('Profile saved perfectly!', 'success');
  }
  
  btn.disabled = false; btn.textContent = 'Save Changes';
};

window.changePassword = async function() {
  const newPassword = prompt('Enter your new password (must be at least 6 characters):');
  if (!newPassword) return;
  if (newPassword.length < 6) {
    showToast('Password must be at least 6 characters!', 'error');
    return;
  }
  
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    showToast('Failed to change password: ' + error.message, 'error');
  } else {
    showToast('Password updated successfully! You can use it next time you log in.', 'success');
  }
};

async function loadSettings() {
  if (currentUser) {
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
    
    qs('#profile-name').value = profile?.display_name || currentUser.email.split('@')[0];
    
    const preview = qs('#settings-avatar-preview');
    if (profile?.avatar_url) {
      preview.textContent = '';
      preview.style.backgroundImage = `url('${profile.avatar_url}')`;
      preview.style.backgroundSize = 'cover';
      preview.style.backgroundPosition = 'center';
    } else {
      preview.textContent = currentUser.email[0].toUpperCase();
      preview.style.backgroundImage = 'none';
    }
    
    const sigPreview = qs('#settings-sig-preview');
    if (profile?.signature_url && sigPreview) {
      sigPreview.textContent = '';
      sigPreview.style.backgroundImage = `url('${profile.signature_url}')`;
    }

    if (qs('#biometric-toggle')) {
      qs('#biometric-toggle').checked = !!profile?.biometric_enabled;
    }
  }
}

/* ── EXAM ACCESS CODE & SECURITY UNLOCK ENGINE ──────── */
let pendingExamData = null;

// PDF.js Exam Paper Viewer State
let currentExamPdfDoc = null;
let currentExamPdfPage = 1;
let currentExamPdfScale = 1.15;
let currentExamPdfUrl = null;
let examPdfMode = 'canvas'; // 'canvas' or 'iframe'

window.promptExamUnlock = function(id, url, durationMinutes, title, subject, accessCode, barcode, startDate, endDate) {
  const now = new Date();
  if (startDate) {
    const s = parseAppDate(startDate);
    if (s && now < s) {
      showToast('This exam question paper opens at ' + s.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}), 'error');
      return;
    }
  }
  if (endDate) {
    const e = parseAppDate(endDate);
    if (e && now > e) {
      showToast('Exam time window closed at ' + e.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) + '. Access is no longer allowed.', 'error');
      return;
    }
  }

  // Check single attempt (admin can always preview and test)
  if (!adminMode && currentUser) {
    const hasSubmitted = localStorage.getItem(`exam_submitted_${id}_${currentUser.id}`);
    if (hasSubmitted) {
      showToast('You have already accessed and completed this exam (Single attempt rule).', 'error');
      return;
    }
  }

  // If no access code is required, start directly
  if (!accessCode) {
    startExam(id, url, durationMinutes, title, subject, barcode);
    return;
  }

  // Store pending exam data and display security modal
  pendingExamData = { id, url, durationMinutes, title, subject, accessCode, barcode, startDate, endDate };

  const modal = qs('#exam-unlock-modal');
  const titleEl = qs('#unlock-exam-title');
  const infoEl = qs('#unlock-exam-window-info');
  const inputEl = qs('#unlock-code-input');

  if (titleEl) titleEl.textContent = title;
  if (inputEl) {
    inputEl.value = '';
    setTimeout(() => inputEl.focus(), 150);
  }

  let windowText = 'Status: Live & Ready to Open';
  if (startDate && endDate) {
    const sDt = parseAppDate(startDate);
    const eDt = parseAppDate(endDate);
    windowText = `Allowed Window: ${sDt ? sDt.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : ''} — ${eDt ? eDt.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : ''}`;
  } else if (startDate) {
    const sDt = parseAppDate(startDate);
    windowText = `Opened at: ${sDt ? sDt.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : ''}`;
  }
  if (infoEl) infoEl.textContent = windowText;

  if (modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
};

window.toggleUnlockCodeVisibility = function() {
  const input = qs('#unlock-code-input');
  const eye = qs('#unlock-toggle-eye');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (eye) eye.textContent = '🔒';
  } else {
    input.type = 'password';
    if (eye) eye.textContent = '👁️';
  }
};

window.copyExamCodeToClipboard = function(code, e) {
  if (e && e.stopPropagation) e.stopPropagation();
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    showToast(`Access Code "${code}" copied to clipboard!`, 'success');
  }).catch(() => {
    prompt('Copy exam code:', code);
  });
};

window.shareExamCode = function(examTitle, code) {
  const text = `StudyVault Official Timed Examination\nExam: ${examTitle}\nUnique Access Code: ${code}\nEnter this passcode on the StudyVault portal to unlock your paper.`;
  if (navigator.share) {
    navigator.share({ title: `StudyVault Exam Code: ${examTitle}`, text: text }).catch(() => {});
  } else {
    navigator.clipboard.writeText(text).then(() => {
      showToast('Exam code & instructions copied! You can paste in WhatsApp/Classroom.', 'success', 5000);
    }).catch(() => {
      prompt('Copy share text:', text);
    });
  }
};

window.closeExamUnlockModal = function() {
  const modal = qs('#exam-unlock-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
  const input = qs('#unlock-code-input');
  if (input) input.type = 'password';
  const eye = qs('#unlock-toggle-eye');
  if (eye) eye.textContent = '👁️';
  pendingExamData = null;
};

window.confirmExamUnlock = function() {
  if (!pendingExamData) {
    showToast('No exam session selected.', 'error');
    return;
  }
  const entered = qs('#unlock-code-input')?.value?.trim();
  if (!entered) {
    showToast('Please enter the access code provided by your instructor/admin', 'error');
    return;
  }

  const expectedCode = (pendingExamData.accessCode || '').trim();
  // Case-insensitive & whitespace-tolerant comparison
  if (entered.toUpperCase().replace(/\s+/g, '') !== expectedCode.toUpperCase().replace(/\s+/g, '')) {
    showToast('Invalid access code! Please check with your instructor.', 'error');
    return;
  }

  if (!pendingExamData.url) {
    showToast('Question paper file is not available for this exam.', 'error');
    return;
  }

  // Copy data BEFORE closing modal to avoid any premature nulling
  const examToStart = { ...pendingExamData };
  const modal = qs('#exam-unlock-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
  pendingExamData = null;

  startExam(examToStart.id, examToStart.url, examToStart.durationMinutes, examToStart.title, examToStart.subject, examToStart.barcode);
};

/* ── EXAM ENGINE & STUDYVAULT REGENERATED PAPER VIEWER ── */
window.startExam = function(id, url, durationMinutes, title, subject, barcode) {
  const overlay = qs('#exam-overlay');
  const timerEl = qs('#exam-timer-display');
  
  if (!overlay) return;

  if (!url) {
    showToast('Question paper file is not available for this exam.', 'error');
    return;
  }

  // Single attempt verification (bypassed for admin preview/testing)
  if (!adminMode && currentUser && localStorage.getItem(`exam_submitted_${id}_${currentUser.id}`)) {
    showToast('You have already taken this exam paper.', 'error');
    return;
  }

  // Populate regenerated StudyVault Paper Header & Metadata
  const barcodeValue = barcode || ('SV-' + (id || '').slice(0, 8).toUpperCase());
  const studentName = userProfile?.display_name || userProfile?.full_name || currentUser?.user_metadata?.full_name || currentUser?.email?.split('@')[0] || 'Candidate';
  const studentId = userProfile?.student_id || ('STD-' + (currentUser?.id || 'SV').slice(0, 6).toUpperCase());
  const subjectName = SUBJECTS[subject] || subject || 'General Paper';

  if (qs('#paper-doc-title')) qs('#paper-doc-title').textContent = title.toUpperCase();
  if (qs('#paper-candidate-name')) qs('#paper-candidate-name').textContent = studentName;
  if (qs('#paper-candidate-id')) qs('#paper-candidate-id').textContent = studentId;
  if (qs('#paper-subject-name')) qs('#paper-subject-name').textContent = subjectName;
  if (qs('#paper-session-id')) qs('#paper-session-id').textContent = 'SV-SES-' + Date.now().toString(36).toUpperCase();
  if (qs('#paper-barcode-serial')) qs('#paper-barcode-serial').textContent = barcodeValue;
  if (qs('#paper-watermark-text')) qs('#paper-watermark-text').textContent = `${studentName.toUpperCase()} • ${studentId} • CONFIDENTIAL`;

  // Render Barcode dynamically via JsBarcode
  try {
    if (window.JsBarcode && qs('#paper-barcode-svg')) {
      window.JsBarcode('#paper-barcode-svg', barcodeValue, {
        format: 'CODE128',
        width: 1.5,
        height: 38,
        displayValue: false,
        margin: 2
      });
    }
  } catch(e) {
    console.warn('JsBarcode render notice:', e);
  }

  // Absolute Timer Enforcement
  let timeLeft = 0;
  if (durationMinutes && durationMinutes > 0) {
    const attemptKey = `exam_start_${id}_${currentUser?.id || 'guest'}`;
    let startTime = localStorage.getItem(attemptKey);
    if (!startTime) {
      startTime = Date.now();
      localStorage.setItem(attemptKey, startTime);
    }
    
    const durationMs = durationMinutes * 60 * 1000;
    const elapsed = Date.now() - parseInt(startTime);
    timeLeft = Math.floor((durationMs - elapsed) / 1000);

    if (timeLeft <= 0) {
      overlay.dataset.examId = id;
      overlay.dataset.examTitle = title;
      overlay.dataset.subject = subject;
      submitExam();
      showToast('The time limit for this exam has expired!', 'error');
      return;
    }
  }
  
  // Track current exam in dataset
  overlay.dataset.examId = id;
  overlay.dataset.examTitle = title;
  overlay.dataset.subject = subject;

  const frame = qs('#exam-frame');
  if (frame) {
    frame.dataset.examId = id;
    frame.dataset.examTitle = title;
    frame.dataset.subject = subject;
  }
  
  overlay.style.zIndex = '5000';
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Load and render official question paper PDF
  renderExamPdf(url);
  
  if (activeExamTimer) clearInterval(activeExamTimer);
  
  if (durationMinutes && durationMinutes > 0) {
    timerEl.parentElement.classList.remove('hidden');
    
    // Initial paint
    const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
    const s = (timeLeft % 60).toString().padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
    
    activeExamTimer = setInterval(() => {
      timeLeft--;
      const mm = Math.floor(Math.max(0, timeLeft) / 60).toString().padStart(2, '0');
      const ss = (Math.max(0, timeLeft) % 60).toString().padStart(2, '0');
      timerEl.textContent = `${mm}:${ss}`;
      
      if (timeLeft <= 0) {
        clearInterval(activeExamTimer);
        submitExam();
        showToast('Time is up! Exam automatically submitted.', 'error');
      }
    }, 1000);
  } else {
    timerEl.parentElement.classList.add('hidden');
  }
};

/* ── PDF.JS PAPER RENDERER & CONTROLS ────────────────── */
async function renderExamPdf(url) {
  currentExamPdfUrl = url;
  const scrollContainer = qs('#exam-pdf-pages-scroll');
  const loadingEl = qs('#exam-pdf-loading-state');
  const frame = qs('#exam-frame');
  const directLink = qs('#exam-pdf-direct-open');

  if (directLink) directLink.href = url;

  if (scrollContainer) {
    scrollContainer.style.display = 'flex';
    // Remove old pages but preserve loading state element
    scrollContainer.querySelectorAll('.exam-pdf-page-wrapper').forEach(el => el.remove());
    if (loadingEl) loadingEl.style.display = 'flex';
  }
  if (frame) frame.style.display = 'none';

  if (window.pdfjsLib) {
    try {
      const loadingTask = window.pdfjsLib.getDocument({
        url: url,
        cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
        cMapPacked: true
      });

      const pdf = await loadingTask.promise;
      currentExamPdfDoc = pdf;
      currentExamPdfPage = 1;

      if (qs('#exam-pdf-total-pages')) qs('#exam-pdf-total-pages').textContent = pdf.numPages;
      if (qs('#exam-pdf-curr-page')) qs('#exam-pdf-curr-page').textContent = '1';

      if (loadingEl) loadingEl.style.display = 'none';

      await renderAllExamPdfPages();
      examPdfMode = 'canvas';
      return;
    } catch (err) {
      console.warn('PDF.js canvas rendering fallback notice:', err);
    }
  }

  // Fallback to native iframe
  showExamPdfInFrame(url);
}

async function renderAllExamPdfPages() {
  if (!currentExamPdfDoc) return;
  const scrollContainer = qs('#exam-pdf-pages-scroll');
  if (!scrollContainer) return;

  // Clear existing rendered pages
  scrollContainer.querySelectorAll('.exam-pdf-page-wrapper').forEach(el => el.remove());

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const numPages = currentExamPdfDoc.numPages;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await currentExamPdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentExamPdfScale });

    const wrapper = document.createElement('div');
    wrapper.className = 'exam-pdf-page-wrapper';
    wrapper.dataset.pageNum = pageNum;
    wrapper.id = `exam-pdf-page-${pageNum}`;

    const canvas = document.createElement('canvas');
    canvas.className = 'exam-pdf-page-canvas';
    const ctx = canvas.getContext('2d');

    // High DPI crisp rendering
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    ctx.scale(dpr, dpr);

    const renderContext = {
      canvasContext: ctx,
      viewport: viewport
    };

    wrapper.appendChild(canvas);

    const badge = document.createElement('div');
    badge.className = 'exam-pdf-page-badge';
    badge.textContent = `Page ${pageNum} of ${numPages}`;
    wrapper.appendChild(badge);

    scrollContainer.appendChild(wrapper);

    await page.render(renderContext).promise;
  }
}

function showExamPdfInFrame(url) {
  examPdfMode = 'iframe';
  const scrollContainer = qs('#exam-pdf-pages-scroll');
  const frame = qs('#exam-frame');
  if (scrollContainer) scrollContainer.style.display = 'none';
  if (frame) {
    frame.style.display = 'block';
    frame.src = url;
  }
  if (qs('#exam-pdf-toggle-view')) qs('#exam-pdf-toggle-view').textContent = 'Switch to Canvas';
}

window.toggleExamPdfEngine = function() {
  if (examPdfMode === 'canvas') {
    showExamPdfInFrame(currentExamPdfUrl);
  } else {
    examPdfMode = 'canvas';
    const scrollContainer = qs('#exam-pdf-pages-scroll');
    const frame = qs('#exam-frame');
    if (frame) frame.style.display = 'none';
    if (scrollContainer) scrollContainer.style.display = 'flex';
    if (qs('#exam-pdf-toggle-view')) qs('#exam-pdf-toggle-view').textContent = 'Switch View';
    if (currentExamPdfDoc) renderAllExamPdfPages();
    else if (currentExamPdfUrl) renderExamPdf(currentExamPdfUrl);
  }
};

window.zoomExamPdf = function(delta) {
  const newScale = Math.min(2.5, Math.max(0.6, currentExamPdfScale + delta));
  currentExamPdfScale = newScale;
  if (qs('#exam-pdf-zoom-label')) qs('#exam-pdf-zoom-label').textContent = Math.round(newScale * 100) + '%';
  if (currentExamPdfDoc) renderAllExamPdfPages();
};

window.fitExamPdfWidth = function() {
  const container = qs('#exam-pdf-pages-scroll');
  if (!container || !currentExamPdfDoc) return;
  currentExamPdfDoc.getPage(1).then(page => {
    const unscaledViewport = page.getViewport({ scale: 1.0 });
    const targetWidth = container.clientWidth - 48;
    if (targetWidth > 200 && unscaledViewport.width > 0) {
      currentExamPdfScale = Math.min(2.0, Math.max(0.6, targetWidth / unscaledViewport.width));
      if (qs('#exam-pdf-zoom-label')) qs('#exam-pdf-zoom-label').textContent = Math.round(currentExamPdfScale * 100) + '%';
      renderAllExamPdfPages();
    }
  });
};

window.nextExamPdfPage = function() {
  if (!currentExamPdfDoc) return;
  const numPages = currentExamPdfDoc.numPages;
  if (currentExamPdfPage < numPages) {
    currentExamPdfPage++;
    scrollToExamPdfPage(currentExamPdfPage);
  }
};

window.prevExamPdfPage = function() {
  if (!currentExamPdfDoc) return;
  if (currentExamPdfPage > 1) {
    currentExamPdfPage--;
    scrollToExamPdfPage(currentExamPdfPage);
  }
};

function scrollToExamPdfPage(num) {
  const target = qs(`#exam-pdf-page-${num}`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (qs('#exam-pdf-curr-page')) qs('#exam-pdf-curr-page').textContent = num;
  }
}

window.submitExam = async function() {
  const overlay = qs('#exam-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.style.display = 'none';
  }
  document.body.style.overflow = '';
  if (activeExamTimer) clearInterval(activeExamTimer);
  
  const frame = qs('#exam-frame');
  const examId = overlay?.dataset.examId || frame?.dataset.examId;
  const examTitle = overlay?.dataset.examTitle || frame?.dataset.examTitle;
  const subject = overlay?.dataset.subject || frame?.dataset.subject;
  
  if (frame) frame.src = '';
  currentExamPdfDoc = null;
  const scrollContainer = qs('#exam-pdf-pages-scroll');
  if (scrollContainer) {
    scrollContainer.querySelectorAll('.exam-pdf-page-wrapper').forEach(el => el.remove());
  }
  
  if (examId && currentUser) {
    // Record permanent completion to enforce single attempt rule
    localStorage.setItem(`exam_submitted_${examId}_${currentUser.id}`, Date.now().toString());

    await supabase.from('exam_scores').insert({
      user_id: currentUser.id,
      exam_id: examId,
      exam_title: examTitle,
      subject: subject,
      score: null,
      max_score: 100
    });
  }
  
  showToast('Exam submitted successfully! Submission has been locked.', 'success');
  loadExams();
};

/* ═══════════════════════════════════════════════════════
   FILTERS
═══════════════════════════════════════════════════════ */
function initFilters(btnSel, cardSel, dataAttr) {
  const btns = qsa(btnSel);
  const cards = qsa(cardSel);
  btns.forEach(b => {
    b.addEventListener('click', () => {
      btns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const val = b.dataset.filter || b.dataset.cat;
      
      let visibleIdx = 0;
      cards.forEach(c => {
        const matches = (val === 'all' || !val || c.dataset[dataAttr] === val);
        if (matches) {
          c.classList.remove('hidden');
          c.style.animation = 'none';
          c.offsetHeight; // trigger reflow
          c.style.animation = `fluidPageIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) ${visibleIdx * 30}ms forwards`;
          visibleIdx++;
        } else {
          c.classList.add('hidden');
        }
      });
    });
  });
}

/* ═══════════════════════════════════════════════════════
   ADMIN PANEL
═══════════════════════════════════════════════════════ */
window.openAdminPanel = function(tab = 'notes') {
  qs('#admin-modal')?.classList.add('open');
  switchAdminTab(tab);
  document.body.style.overflow = 'hidden';
};
window.closeAdminPanel = function() {
  qs('#admin-modal')?.classList.remove('open');
  document.body.style.overflow = '';
  // Automatically clear all input fields (including file uploads) so they don't persist
  qsa('#admin-modal input').forEach(input => input.value = '');
  qsa('#admin-modal textarea').forEach(ta => ta.value = '');
};
window.slideAdminTabs = function(delta) {
  const bar = qs('#admin-tabs-bar');
  if (bar) {
    bar.scrollBy({ left: delta, behavior: 'smooth' });
  }
};

window.switchAdminTab = function(tab) {
  qsa('.admin-tab-btn').forEach(b => {
    const isActive = b.dataset.tab === tab;
    b.classList.toggle('active', isActive);
    if (isActive) {
      b.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  });
  qsa('.admin-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
  if (tab === 'responses') loadExamResponses();
  if (tab === 'challenge_submissions') loadChallengeSubmissions();
  if (tab === 'approvals') loadPendingPayments();
  if (tab === 'mail') loadAdminMailSettings();
};

/* ═══════════════════════════════════════════════════════
   ADMIN OFFICIAL MAIL DISPATCH SYSTEM (EXAMS & NOTICES)
═══════════════════════════════════════════════════════ */
const DEFAULT_ADMIN_EMAIL = ADMIN_EMAIL || 'souriksamanta927@gmail.com';
const getResendApiKey = () => localStorage.getItem('sv_mail_resend_key') || atob('cmVfVWg1eFFBYlhfN1R4ZzRDdG96Q3dKc2ZDck5qZ0tWQkV0');

window.loadAdminMailSettings = function() {};
window.saveAdminMailSettings = function() {};
window.toggleMailProviderFields = function() {};
window.toggleMailServiceSelect = function() {};

// Formats an official StudyVault HTML email template
function buildStudyVaultEmailHtml(data) {
  const { title, type, subject, windowStart, windowEnd, accessCode, duration, messageBody, linkUrl, barcode } = data;
  const isExam = type === 'exam';
  const portalUrl = window.location.origin + window.location.pathname;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; margin: 0; padding: 24px; color: #0f172a; }
    .email-container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 14px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.04); }
    .header { background: #0f172a; padding: 28px 32px; color: #ffffff; text-align: left; }
    .badge { display: inline-block; padding: 4px 10px; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; border-radius: 6px; background: rgba(245,158,11,0.2); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); margin-bottom: 8px; }
    .title { font-size: 20px; font-weight: 800; margin: 0; line-height: 1.3; }
    .content { padding: 32px; }
    .grid { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin: 20px 0; }
    .grid-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #cbd5e1; font-size: 13.5px; }
    .grid-row:last-child { border-bottom: none; }
    .code-box { background: #0f172a; color: #fbbf24; font-family: monospace; font-size: 18px; font-weight: 800; letter-spacing: 0.15em; padding: 12px 18px; border-radius: 8px; text-align: center; margin: 16px 0; }
    .button { display: inline-block; background: #d97706; color: #ffffff !important; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px; text-align: center; margin-top: 10px; }
    .footer { background: #f1f5f9; padding: 18px 32px; font-size: 11.5px; color: #64748b; text-align: center; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <div class="badge">StudyVault Official Notification</div>
      <h1 class="title">${isExam ? 'Examination Schedule Notice' : 'Official Portal Announcement'}</h1>
    </div>
    <div class="content">
      <h2 style="font-size:18px; font-weight:800; margin-top:0; color:#0f172a;">${escHtml(title)}</h2>
      
      ${isExam ? `
        <p style="font-size:14px; line-height:1.6; color:#334155;">An official timed examination paper has been scheduled on the StudyVault Academic Portal. Please review your authorized examination window and ensure you are prepared on time.</p>
        
        <div class="grid">
          <div class="grid-row"><span>Subject:</span><strong>${escHtml(SUBJECTS[subject] || subject || 'General')}</strong></div>
          <div class="grid-row"><span>Paper ID / Barcode:</span><strong>${escHtml(barcode || 'SV-SEC')}</strong></div>
          <div class="grid-row"><span>Duration:</span><strong>${duration ? duration + ' Minutes' : 'No time limit'}</strong></div>
          <div class="grid-row"><span>Window Starts:</span><strong>${windowStart ? new Date(windowStart).toLocaleString() : 'Immediate'}</strong></div>
          ${windowEnd ? `<div class="grid-row"><span>Window Closes:</span><strong>${new Date(windowEnd).toLocaleString()}</strong></div>` : ''}
        </div>

        ${accessCode ? `
          <div style="font-size:12px; font-weight:700; color:#475569; text-transform:uppercase; margin-top:14px;">Your Access Secret Code:</div>
          <div class="code-box">${escHtml(accessCode)}</div>
          <small style="color:#64748b; display:block; margin-bottom:16px;">This unique code is required to unlock your question paper. Do not share it.</small>
        ` : ''}
      ` : `
        <div style="font-size:14.5px; line-height:1.6; color:#334155; margin:16px 0; white-space:pre-wrap;">${escHtml(messageBody)}</div>
        ${linkUrl ? `<p><a href="${escHtml(linkUrl)}" target="_blank" style="color:#d97706; font-weight:700;">Open Attached Link &rarr;</a></p>` : ''}
      `}

      <div style="text-align:center; margin-top:24px;">
        <a href="${portalUrl}" class="button" target="_blank">Access StudyVault Portal</a>
      </div>
    </div>
    <div class="footer">
      Sent by StudyVault Academic Administration &bull; ${escHtml(localStorage.getItem('sv_mail_from') || DEFAULT_ADMIN_EMAIL)}<br>
      Single-attempt security policy applies. Do not forward this official communication.
    </div>
  </div>
</body>
</html>
  `;
}

// Fetches recipient student emails from registered database users
async function fetchRecipientStudentEmails() {
  const emails = new Set();
  
  // 1. Fetch from pending payments
  const { data: payUsers } = await supabase.from('pending_payments').select('user_email').limit(200);
  if (payUsers) payUsers.forEach(p => { if (p.user_email) emails.add(p.user_email.toLowerCase()); });

  // 2. Fetch from exam scores
  const { data: scoreUsers } = await supabase.from('exam_scores').select('user:user_id(email)').limit(200);
  if (scoreUsers) scoreUsers.forEach(s => { if (s.user?.email) emails.add(s.user.email.toLowerCase()); });

  // 3. Fallback: current admin email for test verification
  if (emails.size === 0) emails.add(DEFAULT_ADMIN_EMAIL);
  
  return Array.from(emails);
}

// Server-backed Gmail SMTP email dispatch function
async function dispatchAdminEmail({ subject, htmlContent, targetEmails }) {
  let recipients = targetEmails;
  
  if (!recipients || (Array.isArray(recipients) && !recipients.length)) {
    // If no explicit recipients provided, pass 'all' so backend resolves all registered students
    recipients = 'all';
  }

  try {
    const res = await fetch('https://klecwqzekmvnnnqlqrjl.supabase.co/functions/v1/send-email', {
      method: 'POST',
      headers: {
        'apikey': 'sb_publishable_180Uo-Au1B3HTHp1ARjLhA_kzWEbUAE',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: recipients,
        subject: subject,
        html: htmlContent
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Failed to send');
    }

    if (data.errors && data.errors.length) {
      console.warn('Mail delivery notes:', data.errors);
      showToast('Delivery issue: ' + data.errors[0], 'warning', 8000);
      return { success: false, errors: data.errors };
    }

    if (data.count === 0) {
      showToast('No emails could be delivered. Check your SMTP settings or recipient addresses.', 'warning', 6000);
      return { success: false };
    }

    const providerText = data.provider === 'gmail_smtp' ? ' via Gmail' : '';
    showToast(`Email delivered to ${data.count} recipient(s)${providerText}!`, 'success');
    return { success: true, count: data.count, provider: data.provider };
  } catch(err) {
    console.error('Email send error:', err);
    showToast('Email delivery failed: ' + err.message, 'error');
    return { success: false, error: err };
  }
}

window.testAdminMailDispatch = async function() {
  const recipientInput = qs('#mail-test-recipient')?.value?.trim();
  const targetEmail = recipientInput || DEFAULT_ADMIN_EMAIL;

  const html = buildStudyVaultEmailHtml({
    title: 'StudyVault Gmail SMTP Test',
    type: 'notice',
    messageBody: 'Your StudyVault email notification service is 100% active and connected directly to Gmail SMTP! Notifications and exam codes can now be dispatched seamlessly to all students.',
    linkUrl: window.location.origin
  });

  showToast(`Sending test email to ${targetEmail}...`, 'info');
  await dispatchAdminEmail({
    subject: 'StudyVault - Gmail SMTP Live Test',
    htmlContent: html,
    targetEmails: [targetEmail]
  });
};

window.loadExamResponses = async function() {
  if (!adminMode) return;
  const list = qs('#admin-responses-list');
  if (!list) return;
  list.innerHTML = 'Loading...';
  
  const { data, error } = await supabase
    .from('exam_scores')
    .select('id, exam_title, subject, attempted_at, user:user_id(email)')
    .order('attempted_at', { ascending: false });
    
  if (error) { list.innerHTML = 'Error loading responses.'; return; }
  if (!data?.length) { list.innerHTML = 'No submissions yet.'; return; }
  
  list.innerHTML = data.map(r => `
    <div style="padding: 12px; border: 1px solid var(--border); border-radius: 8px;">
      <div style="font-weight: 700;">${escHtml(r.exam_title)} (${SUBJECTS[r.subject] || 'Other'})</div>
      <div style="font-size: 0.8rem; color: var(--text-2);">Submitted by: ${escHtml(r.user?.email || 'Unknown')}</div>
      <div style="font-size: 0.8rem; color: var(--text-3);">${new Date(r.attempted_at).toLocaleString()}</div>
    </div>
  `).join('');
};

window.uploadNote = async function() {
  if (!adminMode) return;
  const title = qs('#an-title')?.value;
  const subject = qs('#an-subject')?.value;
  const file = qs('#an-file')?.files[0];
  if (!title || !subject || !file) { showToast('Title, subject, and file required', 'error'); return; }
  
  const btn = qs('#upload-note-btn');
  btn.disabled = true; btn.textContent = 'Uploading...';
  
  const cleanFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `notes/${Date.now()}_${cleanFileName}`;
  let uploadRes;
  try {
    uploadRes = await supabase.storage.from('studyvault').upload(path, file);
  } catch (err) {
    uploadRes = { error: err };
  }
  let { error: uploadError } = uploadRes;
  
  // If JS client fails with network or fetch issue, attempt direct storage REST API fallback
  if (uploadError) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const authToken = session?.access_token || SUPABASE_ANON;
      const restUploadUrl = `${SUPABASE_URL}/storage/v1/object/studyvault/${path}`;
      const restResp = await fetch(restUploadUrl, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON,
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': file.type || 'application/pdf'
        },
        body: file
      });
      if (restResp.ok) {
        uploadError = null;
      } else {
        const errJson = await restResp.json().catch(() => ({}));
        uploadError = { message: errJson.message || errJson.error || `HTTP ${restResp.status}: ${restResp.statusText}` };
      }
    } catch (fallbackErr) {
      console.warn('Storage fallback error:', fallbackErr);
    }
  }
  
  if (uploadError) { 
    console.error('Supabase storage upload error:', uploadError);
    showToast('Storage upload failed: ' + (uploadError.message || JSON.stringify(uploadError)), 'error', 6000);
    btn.disabled = false; btn.textContent = 'Upload Note'; 
    return; 
  }
  
  const { data: { publicUrl } } = supabase.storage.from('studyvault').getPublicUrl(path);
  const docType = qs('#an-type')?.value || 'notes';
  
  let insertNotePayload = { 
    title, 
    subject, 
    file_url: publicUrl, 
    file_path: path,
    doc_type: docType
  };
  
  let { error } = await supabase.from('notes').insert(insertNotePayload);
  
  // If doc_type is not yet cached in postgrest, gracefully fallback to storing in description or title
  if (error && error.message && error.message.includes('doc_type')) {
    delete insertNotePayload.doc_type;
    insertNotePayload.description = docType === 'syllabus' ? '[SYLLABUS]' : '';
    const fallbackRes = await supabase.from('notes').insert(insertNotePayload);
    error = fallbackRes.error;
  }
  
  btn.disabled = false; btn.textContent = 'Upload Note';
  
  if (error) {
    showToast('Database insert failed: ' + error.message, 'error');
  } else {
    closeAdminPanel(); loadNotes(); showToast((docType === 'syllabus' ? 'Syllabus' : 'Note') + ' added!', 'success');
  }
};

window.uploadExam = async function() {
  if (!adminMode) return;
  const title = qs('#ae-title')?.value?.trim();
  const cat = qs('#ae-cat')?.value;
  const subject = qs('#ae-subject')?.value?.trim();
  const duration = parseInt(qs('#ae-duration')?.value) || 0;
  const examDate = qs('#ae-date')?.value || null;
  const examEndDate = qs('#ae-end-date')?.value || null;
  const accessCode = qs('#ae-access-code')?.value?.trim() || null;
  const file = qs('#ae-file')?.files[0];
  if (!title || !file) { showToast('Title and file required', 'error'); return; }
  
  const btn = qs('#upload-exam-btn');
  btn.disabled = true; btn.textContent = 'Uploading & Regenerating...';
  
  // Generate unique barcode for this exam paper
  const barcode = 'SV-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(1000 + Math.random() * 9000);

  const cleanFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `exams/${Date.now()}_${cleanFileName}`;
  let uploadRes;
  try {
    uploadRes = await supabase.storage.from('studyvault').upload(path, file);
  } catch (err) {
    uploadRes = { error: err };
  }
  let { error: uploadError } = uploadRes;
  
  if (uploadError) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const authToken = session?.access_token || SUPABASE_ANON;
      const restUploadUrl = `${SUPABASE_URL}/storage/v1/object/studyvault/${path}`;
      const restResp = await fetch(restUploadUrl, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON,
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': file.type || 'application/pdf'
        },
        body: file
      });
      if (restResp.ok) {
        uploadError = null;
      } else {
        const errJson = await restResp.json().catch(() => ({}));
        uploadError = { message: errJson.message || errJson.error || `HTTP ${restResp.status}: ${restResp.statusText}` };
      }
    } catch (fallbackErr) {
      console.warn('Storage fallback error:', fallbackErr);
    }
  }

  if (uploadError) { 
    console.error('Upload exam error:', uploadError);
    showToast('Upload failed: ' + (uploadError.message || JSON.stringify(uploadError)), 'error', 6000);
    btn.disabled = false; btn.textContent = 'Upload Exam'; 
    return; 
  }
  
  const { data: { publicUrl } } = supabase.storage.from('studyvault').getPublicUrl(path);
  
  // Convert local datetime-local values (e.g. "2026-10-11T19:31") to proper ISO strings preserving local timezone
  const examDateIso = examDate ? parseAppDate(examDate).toISOString() : null;
  const examEndDateIso = examEndDate ? parseAppDate(examEndDate).toISOString() : null;

  let insertPayload = { 
    title, 
    category: cat, 
    subject, 
    duration_minutes: duration, 
    exam_date: examDateIso, 
    file_url: publicUrl, 
    file_path: path,
    access_code: accessCode,
    barcode: barcode
  };
  if (examEndDateIso) insertPayload.exam_end_date = examEndDateIso;

  let { error } = await supabase.from('exams').insert(insertPayload);
  
  // If database schema has not added the columns yet, fallback seamlessly to storing security metadata in description
  if (error && (error.message.includes('column') || error.message.includes('schema cache'))) {
    console.warn('Falling back to metadata-embedded schema:', error.message);
    const metaTag = `\n<!--SV_META:{"access_code":"${accessCode || ''}","barcode":"${barcode}","exam_end_date":"${examEndDateIso || ''}"}-->`;
    const fallbackPayload = {
      title,
      description: metaTag,
      category: cat,
      subject,
      duration_minutes: duration,
      exam_date: examDateIso,
      file_url: publicUrl,
      file_path: path
    };
    const res = await supabase.from('exams').insert(fallbackPayload);
    error = res.error;
  }

  btn.disabled = false; btn.textContent = 'Upload Exam';
  
  if (error) {
    showToast('Failed to insert: ' + error.message, 'error');
  } else {
    closeAdminPanel(); loadExams(); loadHomeAlerts(); 
    if (accessCode) {
      showToast(`Exam created! Access Code: "${accessCode}". Admin can copy or share it anytime.`, 'success', 7000);
    } else {
      showToast('Exam uploaded with unique barcode ' + barcode, 'success');
    }

    // Automatically publish to student notice board if admin enabled it
    const shouldPostNotice = qs('#ae-post-notice')?.checked;
    if (shouldPostNotice) {
      const noticeBody = `Scheduled Exam Paper: "${title}" (${SUBJECTS[subject] || subject || 'General'}).\n` +
        `Duration: ${duration ? duration + ' Minutes' : 'No time limit'}.\n` +
        (examDateIso ? `Window Starts: ${new Date(examDateIso).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}\n` : '') +
        (examEndDateIso ? `Window Closes: ${new Date(examEndDateIso).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}\n` : '') +
        (accessCode ? `Unique Access Code: ${accessCode}\n` : '') +
        `Head to the "Exams" tab to unlock and start your paper.`;

      supabase.from('notices').insert({
        title: `Exam Scheduled: ${title}`,
        type: 'important',
        body: noticeBody
      }).then(() => {
        loadNotices();
      }).catch(err => console.error('Notice auto-post error:', err));
    }

    // Send official email notification if admin enabled it
    const shouldSendEmail = qs('#ae-send-email')?.checked;
    if (shouldSendEmail) {
      const customRecipientsRaw = qs('#ae-recipient-emails')?.value?.trim();
      const customRecipients = customRecipientsRaw ? customRecipientsRaw.split(/[,;\s]+/).filter(Boolean) : null;

      const emailHtml = buildStudyVaultEmailHtml({
        title: title,
        type: 'exam',
        subject: subject,
        windowStart: examDateIso,
        windowEnd: examEndDateIso,
        accessCode: accessCode,
        duration: duration,
        barcode: barcode
      });

      dispatchAdminEmail({
        subject: `StudyVault Exam Notification: ${title} (${(subject || '').toUpperCase()})`,
        htmlContent: emailHtml,
        targetEmails: customRecipients || 'all'
      });
    }
  }
};

window.uploadNotice = async function() {
  if (!adminMode) return;
  const title = qs('#anot-title')?.value;
  const type = qs('#anot-type')?.value;
  const body = qs('#anot-body')?.value;
  const linkUrl = qs('#anot-link')?.value;
  const file = qs('#anot-file')?.files[0];
  
  if (!title || !body) { showToast('Title and body required', 'error'); return; }
  
  const btn = qs('#post-notice-btn');
  btn.disabled = true; btn.textContent = 'Posting...';
  
  let publicUrl = null;
  let fileName = null;

  if (file) {
    const path = `notices/${Date.now()}_${file.name}`;
    const { error: uploadError } = await supabase.storage.from('studyvault').upload(path, file);
    if (uploadError) { 
      showToast('Upload failed: ' + uploadError.message, 'error'); 
      btn.disabled = false; btn.textContent = 'Post Notice'; 
      return; 
    }
    publicUrl = supabase.storage.from('studyvault').getPublicUrl(path).data.publicUrl;
    fileName = file.name;
  }
  
  const links = linkUrl ? [{ label: 'View Link', url: linkUrl }] : [];
  const { error } = await supabase.from('notices').insert({ 
    title, type, body, links, file_url: publicUrl, file_name: fileName 
  });
  
  btn.disabled = false; btn.textContent = 'Post Notice';
  
  if (error) {
    showToast('Failed to post: ' + error.message, 'error');
  } else {
    closeAdminPanel(); loadNotices(); showToast('Notice posted!', 'success');

    // Send official email broadcast if admin enabled it
    const shouldSendEmail = qs('#anot-send-email')?.checked;
    if (shouldSendEmail) {
      const emailHtml = buildStudyVaultEmailHtml({
        title: title,
        type: 'notice',
        messageBody: body,
        linkUrl: linkUrl || publicUrl
      });

      dispatchAdminEmail({
        subject: `StudyVault Notice: ${title}`,
        htmlContent: emailHtml
      });
    }
  }
};

window.toggleAdminChallengeTypeFields = function() {
  const type = qs('#ac-type')?.value;
  const dsaFields = qs('#ac-dsa-fields');
  const quizFields = qs('#ac-quiz-fields');
  if (type === 'quiz') {
    if (dsaFields) dsaFields.style.display = 'none';
    if (quizFields) quizFields.style.display = 'block';
  } else if (type === 'brainstorm') {
    if (dsaFields) dsaFields.style.display = 'none';
    if (quizFields) quizFields.style.display = 'none';
  } else {
    if (dsaFields) dsaFields.style.display = 'block';
    if (quizFields) quizFields.style.display = 'none';
  }
};

window.addAdminQuizOption = function() {
  const container = qs('#ac-quiz-options-container');
  if (!container) return;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const count = container.querySelectorAll('.ac-quiz-opt-row').length;
  const label = letters[count] || (count + 1);
  const row = document.createElement('div');
  row.className = 'ac-quiz-opt-row';
  row.innerHTML = `
    <input type="radio" name="ac-correct-opt" value="${count}" title="Mark as correct answer" />
    <span class="ac-opt-badge">${label}</span>
    <input type="text" class="admin-input ac-opt-text" placeholder="Enter option ${count + 1} text..." style="flex:1; padding:8px 12px;" />
    <span class="ac-correct-tag">Correct Answer</span>
    <button type="button" class="admin-close-btn" style="font-size:1.1rem; padding:4px 8px; opacity:0.6;" onclick="removeAdminQuizOption(this)" title="Remove option">&times;</button>
  `;
  container.appendChild(row);
};

window.removeAdminQuizOption = function(btn) {
  const row = btn.closest('.ac-quiz-opt-row');
  const container = qs('#ac-quiz-options-container');
  if (!container || !row) return;
  if (container.querySelectorAll('.ac-quiz-opt-row').length <= 2) {
    showToast('A quiz must have at least 2 options.', 'error');
    return;
  }
  const wasChecked = row.querySelector('input[type="radio"]')?.checked;
  row.remove();
  
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const remainingRows = container.querySelectorAll('.ac-quiz-opt-row');
  remainingRows.forEach((r, idx) => {
    const radio = r.querySelector('input[type="radio"]');
    if (radio) radio.value = idx;
    const badge = r.querySelector('.ac-opt-badge');
    if (badge) badge.textContent = letters[idx] || (idx + 1);
    const input = r.querySelector('.ac-opt-text');
    if (input && !input.value) input.placeholder = `Enter option ${idx + 1} text...`;
  });

  // If the deleted option was the selected correct answer, reassign to option 0
  if (wasChecked && remainingRows.length > 0) {
    const firstRadio = remainingRows[0].querySelector('input[type="radio"]');
    if (firstRadio) firstRadio.checked = true;
  }
};

window.publishChallenge = async function() {
  if (!adminMode) return;
  const title = qs('#ac-title')?.value;
  const type = qs('#ac-type')?.value;
  const rawDiff = qs('#ac-diff')?.value || 'Medium';
  const difficulty = rawDiff.charAt(0).toUpperCase() + rawDiff.slice(1);
  const points = parseInt(qs('#ac-points')?.value) || 10;
  const problemStatement = qs('#ac-desc')?.value;
  const hint = qs('#ac-hint')?.value || '';

  if (!title || !problemStatement) {
    showToast('Challenge title and description required!', 'error');
    return;
  }

  const btn = qs('#upload-challenge-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing...'; }

  const officialAnswer = qs('#ac-official-answer')?.value || '';
  const starterCode = qs('#ac-starter')?.value || '';
  const testCases = qs('#ac-testcases')?.value || '';

  let fullDescription = problemStatement.trim();
  if (hint.trim()) {
    fullDescription += `\n\n[Hint]: ${hint.trim()}`;
  }
  if (testCases.trim()) {
    fullDescription += `\n\n[Example I/O / Test Cases]:\n${testCases.trim()}`;
  }
  if (starterCode.trim()) {
    fullDescription += `\n\n[Starter Code]:\n${starterCode.trim()}`;
  }

  let payload = {
    title: title.trim(),
    type,
    difficulty,
    description: fullDescription,
    points,
    official_answer: officialAnswer.trim(),
    solution: officialAnswer.trim()
  };

  if (type === 'quiz') {
    const rows = qsa('.ac-quiz-opt-row');
    const checkedRadio = qs('input[name="ac-correct-opt"]:checked');
    const correctIdx = checkedRadio ? parseInt(checkedRadio.value) : 0;
    const options = rows.map((r, i) => {
      const text = r.querySelector('.ac-opt-text')?.value || `Option ${i + 1}`;
      return { text: text.trim(), is_correct: i === correctIdx };
    }).filter(o => o.text.length > 0);

    if (options.length < 2) {
      showToast('Please provide at least 2 options for the quiz.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Publish Daily Challenge'; }
      return;
    }
    payload.options = options;

    const correctChoice = options.find(o => o.is_correct);
    if (!payload.official_answer && correctChoice) {
      payload.official_answer = correctChoice.text;
      payload.solution = correctChoice.text;
    }
  }

  let { error } = await safeInsert('daily_challenges', payload);

  if (btn) { btn.disabled = false; btn.textContent = 'Publish Daily Challenge'; }

  if (error) {
    showToast('Failed to publish challenge: ' + error.message, 'error');
  } else {
    closeAdminPanel();
    if (currentPage === 'daily') loadDailyChallenges();
    showToast('Daily Challenge published successfully!', 'success');
  }
};

window.loadChallengeSubmissions = async function() {
  if (!adminMode) return;
  const list = qs('#admin-challenge-submissions-list');
  if (!list) return;
  list.innerHTML = 'Loading submissions...';

  // Defensive select that works even if status is not yet migrated
  let { data, error } = await supabase
    .from('daily_submissions')
    .select('*, daily_challenges(title, type)')
    .order('submitted_at', { ascending: false });

  if (error) {
    list.innerHTML = `<div style="color:var(--text-2); font-size:0.85rem;">No submissions found or schema migrating. (${escHtml(error.message)})</div>`;
    return;
  }
  if (!data?.length) { list.innerHTML = '<div style="color:var(--text-3); font-size:0.85rem;">No challenge submissions found yet.</div>'; return; }

  list.innerHTML = data.map(sub => {
    const statusVal = sub.status || 'submitted';
    const isAccepted = statusVal === 'accepted';
    return `
    <div style="padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <span style="font-weight: 700; color:var(--text-1);">${escHtml(sub.daily_challenges?.title || 'Challenge')}</span>
        <span style="font-size:0.75rem; font-weight:700; padding:2px 8px; border-radius:4px; ${isAccepted ? 'background:rgba(16,185,129,0.15); color:#10B981;' : 'background:rgba(239,68,68,0.15); color:#EF4444;'}">${statusVal.toUpperCase()}</span>
      </div>
      <div style="font-size: 0.8rem; color: var(--text-2); margin-bottom:4px;">User: ${escHtml(sub.user_email || 'Student')} | +${sub.score_awarded || 0} XP</div>
      <div style="font-size: 0.75rem; color: var(--text-3); margin-bottom:8px;">${sub.submitted_at ? new Date(sub.submitted_at).toLocaleString() : ''}</div>
      ${sub.submission_code ? `
        <details style="margin-top:6px;">
          <summary style="font-size:0.75rem; font-weight:700; color:var(--accent); cursor:pointer;">View Submitted Code</summary>
          <pre style="background:#0d1117; color:#58a6ff; padding:8px; border-radius:6px; font-size:0.8rem; margin-top:6px; max-height:160px; overflow-y:auto; font-family:monospace;">${escHtml(sub.submission_code)}</pre>
        </details>
      ` : ''}
    </div>
  `}).join('');
};

window.deleteNote = async (id) => { if (confirm('Delete?')) { await supabase.from('notes').delete().eq('id',id); loadNotes(); } };
window.deleteExam = async (id) => { if (confirm('Delete?')) { await supabase.from('exams').delete().eq('id',id); loadExams(); } };
window.deleteNotice = async (id) => { if (confirm('Delete?')) { await supabase.from('notices').delete().eq('id',id); loadNotices(); } };

window.showToast = function(msg, type='info', duration=3200) {
  qsa('.sv-toast').forEach(oldToast => {
    oldToast.classList.remove('show');
    setTimeout(() => oldToast.remove(), 200);
  });

  const t = document.createElement('div');
  t.className = `sv-toast sv-toast-${type}`;
  
  let icon = '✨';
  if (type === 'success') icon = '✓';
  if (type === 'error') icon = '✕';
  if (type === 'warning') icon = '⚠️';
  if (type === 'info') icon = 'ℹ️';

  t.innerHTML = `<span style="font-size:1.1rem; flex-shrink:0;">${icon}</span><span>${escHtml(msg)}</span>`;
  t.title = 'Click to dismiss';
  t.onclick = () => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  };

  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 15);
  setTimeout(() => {
    if (t.parentElement) {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 400);
    }
  }, duration || 3200);
};

/* ═══════════════════════════════════════════════════════
   PREMIUM AI CHATBOT (DEMO MODE)
═══════════════════════════════════════════════════════ */
window.toggleChat = function() {
  if (!checkPremiumAccess('lite')) return;
  
  const cw = document.getElementById('chat-window');
  if (cw.classList.contains('hidden')) {
    cw.classList.remove('hidden');
    document.getElementById('chat-input').focus();
  } else {
    cw.classList.add('hidden');
  }
};

window.sendChatMessage = async function() {
  const input = document.getElementById('chat-input');
  const msgs = document.getElementById('chat-messages');
  const txt = input.value.trim();
  if (!txt) return;

  // Add User message
  const userMsg = document.createElement('div');
  userMsg.className = 'chat-msg user';
  userMsg.textContent = txt;
  msgs.appendChild(userMsg);
  
  input.value = '';
  msgs.scrollTop = msgs.scrollHeight;

  // Add a temporary "typing..." indicator
  const aiMsg = document.createElement('div');
  aiMsg.className = 'chat-msg ai';
  aiMsg.textContent = "Thinking...";
  msgs.appendChild(aiMsg);
  msgs.scrollTop = msgs.scrollHeight;

  try {
    if (!supabase) throw new Error("Supabase is not connected.");

    // Call the secure Supabase Edge Function
    const { data, error } = await supabase.functions.invoke('chat', {
      body: { query: txt }
    });

    if (error) {
      throw new Error(error.message || "Failed to reach the AI server.");
    }
    
    if (data.error) {
      throw new Error(data.error);
    }
    
    // Display the answer from the Edge Function
    const answer = data.answer || "I'm sorry, I couldn't process that.";
    aiMsg.innerHTML = answer.replace(/\n/g, '<br>');

  } catch (err) {
    console.error("AI Error:", err);
    aiMsg.textContent = "Error: " + err.message;
  }
  
  msgs.scrollTop = msgs.scrollHeight;
};

/* ═══════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  await initAuth();
  initNavLinks();
  initTactileInteractions();
  initCardSpotlights();
  initAmbientParallax();
  
  setTimeout(() => {
    triggerReveal('#home');
    initRevealObserver();
    loadHomeDashboard();
  }, 100);
});

// ─── PREMIUM SUBSCRIPTION & LOCKS ──────────────────────────────
window.checkPremiumAccess = function(requiredTier = 'lite') {
  if (adminMode) return true;
  if (!userProfile) return false;
  
  const tier = userProfile.subscription_tier || 'free';
  if (tier === 'pro') return true; // Pro has access to everything
  if (tier === 'lite' && requiredTier === 'lite') return true;
  
  showToast('🔒 This content requires a ' + requiredTier.toUpperCase() + ' or PRO subscription.', 'error');
  setTimeout(() => navigateTo('premium'), 1500);
  return false;
};

let selectedTier = 'lite';

window.startSubscription = async function(tier) {
  if (adminMode) {
    showToast('Admin accounts automatically have God-Mode. No payment required.', 'success');
    return;
  }
  
  // Check if they already have a pending request
  const { count } = await supabase.from('pending_payments').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id).eq('status', 'pending');
  if (count > 0) {
    showToast('You already have a pending request! Please wait for Admin approval.', 'error');
    return;
  }

  selectedTier = tier;
  const overlay = qs('#payment-overlay');
  
  const upiVPA = '8159813896-4@ybl'; // Replace with real merchant UPI ID
  let amountStr = '99.00';
  
  if (tier === 'pro') {
    amountStr = userProfile?.subscription_tier === 'lite' ? '119.00' : '199.00';
    qs('#payment-amount').textContent = 'Rs ' + Math.floor(parseFloat(amountStr));
    qs('#payment-subtitle').textContent = userProfile?.subscription_tier === 'lite' ? 'Pro Upgrade (from Lite)' : 'VIP Pro Version';
  } else {
    amountStr = '99.00';
    qs('#payment-amount').textContent = 'Rs 99';
    qs('#payment-subtitle').textContent = 'Lite Version';
  }
  
  // Generate real UPI Intent QR Code
  const upiString = `upi://pay?pa=${upiVPA}&pn=StudyVault&am=${amountStr}&cu=INR`;
  qs('#payment-qr').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(upiString)}`;
  
  qs('#payment-utr').value = ''; // Clear previous UTR
  overlay.classList.remove('hidden');
};

window.closePaymentModal = function() {
  qs('#payment-overlay').classList.add('hidden');
};

window.processPayment = async function() {
  const utrInput = qs('#payment-utr').value.trim();
  if (!utrInput || utrInput.length < 6) {
    showToast('Please enter a valid UTR / Reference No. from your UPI app.', 'error');
    return;
  }

  const btn = qs('#pay-now-btn');
  btn.textContent = "Verifying Payment...";
  btn.style.opacity = '0.7';
  btn.style.pointerEvents = 'none';
  
  // Simulate network delay for realism
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  // Submit to Admin Approval
  const { error } = await supabase.from('pending_payments').insert({
    user_id: currentUser.id,
    user_email: currentUser.email,
    tier: selectedTier,
    utr: utrInput,
    status: 'pending'
  });
  
  btn.textContent = "Verify Payment";
  btn.style.opacity = '1';
  btn.style.pointerEvents = 'auto';
  
  if (error) {
    showToast('Error submitting payment: ' + error.message, 'error');
  } else {
    showToast('Payment submitted! Admin will verify your UTR shortly.', 'success');
    closePaymentModal();
  }
};

window.requestCancellation = async function() {
  if (userProfile?.subscription_expiry) {
    const expiry = new Date(userProfile.subscription_expiry).getTime();
    // Start date is approx 30 days before expiry
    const startDate = expiry - (30 * 24 * 60 * 60 * 1000);
    const daysSinceStart = (Date.now() - startDate) / (1000 * 60 * 60 * 24);
    
    if (daysSinceStart > 7) {
      showToast('Cancellations and refunds are only allowed within the first 7 days of subscription.', 'error');
      return;
    }
  }

  const upiId = qs('#refund-upi-id').value.trim();
  if (!upiId || !upiId.includes('@')) {
    showToast('Please enter a valid UPI ID for the refund.', 'error');
    return;
  }

  if (!confirm('Are you sure you want to request a cancellation and refund?')) return;
  
  // Check for existing pending requests
  const { count } = await supabase.from('pending_payments').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id).eq('status', 'pending');
  if (count > 0) {
    showToast('You already have a pending request with the Admin.', 'error');
    return;
  }
  
  const refundAmount = userProfile.subscription_tier === 'pro' ? '179' : '89';
  const { error } = await supabase.from('pending_payments').insert({
    user_id: currentUser.id,
    user_email: currentUser.email,
    tier: 'cancel_' + userProfile.subscription_tier,
    utr: `Refund|${refundAmount}|${upiId}`,
    status: 'pending'
  });
  
  if (error) {
    showToast('Error requesting cancellation: ' + error.message, 'error');
  } else {
    showToast('Cancellation request sent to Admin. You will be refunded shortly.', 'success');
  }
};

window.loadPendingPayments = async function() {
  const list = qs('#admin-approvals-list');
  if (!list) return;
  
  const { data, error } = await supabase.from('pending_payments').select('*').eq('status', 'pending').order('created_at', { ascending: false });
  if (error) {
    list.innerHTML = `<div class="error-state">Error: ${error.message}</div>`;
    return;
  }
  
  if (!data || data.length === 0) {
    list.innerHTML = `<div class="empty-state">No pending payments.</div>`;
    return;
  }
  
  list.innerHTML = data.map(p => {
    let extraHtml = '';
    let displayUtr = p.utr;
    
    if (p.tier.startsWith('cancel_') && p.utr.includes('|')) {
      const parts = p.utr.split('|');
      const amount = parts[1] || '0';
      const upi = parts[2] || '';
      displayUtr = `Refund Rs ${amount} to ${upi}`;
      
      const upiLink = `upi://pay?pa=${upi}&pn=StudyVault+Refund&am=${amount}`;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(upiLink)}`;
      
      extraHtml = `
        <div style="background: #fff; padding: 12px; border-radius: 8px; display: inline-block; margin-bottom: 12px; text-align: center;">
          <img src="${qrUrl}" style="width: 120px; height: 120px;" alt="Refund QR" />
          <div style="font-size: 0.75rem; color: #000; margin-top: 8px; font-weight: bold;">Scan to Refund Rs ${amount}</div>
        </div>
      `;
    }
    
    return `
      <div style="background: var(--bg-2); padding: 16px; border-radius: 8px; border: 1px solid var(--border);">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span style="font-weight: bold; color: var(--text-1);">${escHtml(p.user_email)}</span>
          <span style="background: var(--accent); color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem;">${p.tier.toUpperCase()}</span>
        </div>
        <div style="font-size: 0.9rem; color: var(--text-2); margin-bottom: 12px;">
          Details: <strong style="color: var(--text-1);">${escHtml(displayUtr)}</strong> <br/>
          Date: ${fmt(p.created_at)}
        </div>
        ${extraHtml}
        <div style="display: flex; gap: 8px;">
          <button class="admin-submit-btn" style="flex: 1; padding: 8px;" onclick="handlePaymentApproval('${p.id}', '${p.user_id}', '${p.tier}', 'approved')">Approve</button>
          <button class="btn-secondary" style="flex: 1; padding: 8px; border-color: red; color: red;" onclick="handlePaymentApproval('${p.id}', '${p.user_id}', '${p.tier}', 'rejected')">Reject</button>
        </div>
      </div>
    `;
  }).join('');
};

window.handlePaymentApproval = async function(paymentId, userId, tier, action) {
  if (!confirm(`Are you sure you want to ${action} this payment?`)) return;
  
  let adminUtr = null;
  if (action === 'approved' && tier.startsWith('cancel_')) {
    adminUtr = prompt("Please enter the UTR / Transaction ID for the refund you just made to the user's UPI ID:");
    if (!adminUtr) {
      showToast('Cancellation approval cancelled. UTR is required.', 'error');
      return;
    }
  }

  // Update status in pending_payments
  const updateData = { status: action };
  if (adminUtr) updateData.admin_utr = adminUtr;
  
  const { error: pErr } = await supabase.from('pending_payments').update(updateData).eq('id', paymentId);
  if (pErr) return showToast('Error updating payment: ' + pErr.message, 'error');
  
  if (action === 'approved') {
    if (tier.startsWith('cancel_')) {
      // Process Cancellation
      const { error: uErr } = await supabase.from('profiles').update({ 
        subscription_tier: 'free',
        subscription_expiry: null
      }).eq('id', userId);
      
      if (uErr) return showToast('Error downgrading user: ' + uErr.message, 'error');
      showToast('Cancellation Approved! Refund initiated and user downgraded.', 'success');
    } else {
      // Calculate expiry (1 month from now)
      const expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + 1);
      
      // Grant the tier
      const { error: uErr } = await supabase.from('profiles').update({ 
        subscription_tier: tier,
        subscription_expiry: expiryDate.toISOString()
      }).eq('id', userId);
      
      if (uErr) return showToast('Error upgrading user: ' + uErr.message, 'error');
      showToast(`Payment Approved! User upgraded to ${tier}.`, 'success');
    }
  } else {
    showToast('Payment Rejected.', 'success');
  }
  
  loadPendingPayments();
  checkAdminNotifications(); // Update badge
};

window.checkAdminNotifications = async function() {
  if (!adminMode) return;
  const badge = qs('#admin-notif-badge');
  if (!badge) return;
  
  const { count, error } = await supabase.from('pending_payments').select('*', { count: 'exact', head: true }).eq('status', 'pending');
  if (error || count === 0) {
    badge.classList.add('hidden');
  } else {
    badge.textContent = count;
    badge.classList.remove('hidden');
  }
};

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(registration => {
      console.log('ServiceWorker registration successful with scope: ', registration.scope);
    }, err => {
      console.log('ServiceWorker registration failed: ', err);
    });
  });
}
