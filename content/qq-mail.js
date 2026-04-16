// content/qq-mail.js — Content script for QQ Mail (steps 4, 7)
// Injected on: mail.qq.com, wx.mail.qq.com, exmail.qq.com
// NOTE: all_frames: true
//
// Strategy for avoiding stale codes:
// 1. On poll start, snapshot all existing mail IDs as "old"
// 2. On each poll cycle, refresh inbox and look for NEW items (not in snapshot)
// 3. Only extract codes from NEW items that match sender/subject filters

const QQ_MAIL_PREFIX = '[MultiPage:qq-mail]';
const isTopFrame = window === window.top;

console.log(QQ_MAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// ============================================================
// Message Handler
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    if (!isTopFrame) {
      sendResponse({ ok: false, reason: 'wrong-frame' });
      return;
    }
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      log(`Step ${message.step}: Poll attempt failed, background will decide whether to resend/retry: ${err.message}`, 'warn');
      sendResponse({ error: err.message });
    });
    return true; // async response
  }
});

// ============================================================
// Get all current mail IDs from the list
// ============================================================

function getCurrentMailIds() {
  const ids = new Set();
  document.querySelectorAll('.mail-list-page-item[data-mailid]').forEach(item => {
    ids.add(item.getAttribute('data-mailid'));
  });
  return ids;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readAttr(el, name) {
  try {
    return el?.getAttribute?.(name) || '';
  } catch {
    return '';
  }
}

function getMailItemMeta(item) {
  const sender = normalizeText(item.querySelector('.cmp-account-nick')?.textContent || '');
  const subject = normalizeText(item.querySelector('.mail-subject')?.textContent || '');
  const digest = normalizeText(item.querySelector('.mail-digest')?.textContent || '');
  const itemText = normalizeText(item.innerText || item.textContent || '');
  const ariaLabel = normalizeText(readAttr(item, 'aria-label'));
  const titleTexts = [];

  const annotatedNodes = item.querySelectorAll('[title], [aria-label]');
  for (const node of annotatedNodes) {
    const title = normalizeText(readAttr(node, 'title'));
    const label = normalizeText(readAttr(node, 'aria-label'));
    if (title) titleTexts.push(title);
    if (label) titleTexts.push(label);
    if (titleTexts.length >= 20) break;
  }

  const combinedText = normalizeText([
    sender,
    subject,
    digest,
    itemText,
    ariaLabel,
    titleTexts.join(' '),
  ].join(' '));

  return {
    sender,
    subject,
    digest,
    combinedText,
  };
}

function scoreOpenedMailText(text, meta = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return -1;

  const lower = normalized.toLowerCase();
  let score = 0;

  if (extractVerificationCode(normalized)) score += 20;
  if (/openai|chatgpt|verification|verify|login code|one-time|otp/i.test(normalized)) score += 12;
  if (/验证码|代码|登录代码|临时|一次性/.test(normalized)) score += 12;

  const sender = normalizeText(meta.sender).toLowerCase();
  if (sender && lower.includes(sender)) score += 6;

  const subjectTokens = normalizeText(meta.subject)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter(token => token.length >= 2);
  for (const token of subjectTokens.slice(0, 8)) {
    if (lower.includes(token)) score += 2;
  }

  return score;
}

function collectOpenedMailTextCandidates(meta = {}) {
  const candidates = [];
  const seen = new Set();

  function pushCandidate(text, source) {
    const normalized = normalizeText(text);
    if (!normalized || normalized.length < 6) return;
    const key = `${source}:${normalized.slice(0, 400)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      source,
      text: normalized,
      score: scoreOpenedMailText(normalized, meta),
    });
  }

  document.querySelectorAll('.mail-detail-content .qmbox').forEach((el, index) => {
    pushCandidate(el.innerText || el.textContent || '', `qmbox-${index}`);
  });

  const detailSelectors = [
    '.mail-detail-content .qmbox',
    '.mail-detail-content',
    '[data-a11y="region"] .qmbox',
    '[data-a11y="region"]',
    '[role="document"]',
  ];

  document.querySelectorAll(detailSelectors.join(', ')).forEach((el, index) => {
    pushCandidate(el.innerText || el.textContent || '', `detail-${index}`);
  });

  document.querySelectorAll('iframe').forEach((frame, index) => {
    try {
      const frameDoc = frame.contentDocument;
      const frameBody = frameDoc?.body;
      if (!frameBody) return;
      pushCandidate(frameBody.innerText || frameBody.textContent || '', `iframe-${index}`);
    } catch {}
  });

  return candidates.sort((a, b) => (b.score - a.score) || (b.text.length - a.text.length));
}

async function extractCodeFromOpenedMail(item, step, meta = {}) {
  const clickTarget = item.querySelector('.mail-subject') || item;
  simulateClick(clickTarget);
  await sleep(500);

  for (let attempt = 1; attempt <= 8; attempt++) {
    throwIfStopped();
    const candidates = collectOpenedMailTextCandidates(meta);
    for (const candidate of candidates) {
      const code = extractVerificationCode(candidate.text);
      if (code) {
        log(`Step ${step}: Code found from opened QQ mail body (${candidate.source})`, 'ok');
        return code;
      }
    }
    await sleep(300);
  }

  return null;
}

async function extractCodeFromMailItem(item, step, meta = {}) {
  const inlineCode = extractVerificationCode(meta.combinedText || '');
  if (inlineCode) {
    return inlineCode;
  }

  log(`Step ${step}: QQ item matched filters but list text had no code. Opening email body...`, 'info');
  return await extractCodeFromOpenedMail(item, step, meta);
}

function findVisibleDeleteButton() {
  const buttons = document.querySelectorAll('.ui-toolbar-ellipsis-btns .xmail-ui-btn');
  for (const button of buttons) {
    const text = (button.querySelector('.ui-btn-text')?.textContent || '').trim();
    const title = (button.getAttribute('title') || button.getAttribute('aria-label') || '').trim();
    const style = window.getComputedStyle(button);
    if ((/^(删除|delete)$/i.test(text) || /删除|delete/i.test(title))
      && style.visibility !== 'hidden'
      && style.display !== 'none') {
      return button;
    }
  }
  return null;
}

async function ensureMailSelected(item) {
  if (item.classList.contains('mail-item-checked')) return;

  const checkbox = item.querySelector('.mail-checkbox, .xmail-ui-checkbox');
  if (checkbox) {
    simulateClick(checkbox);
  } else {
    simulateClick(item);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    throwIfStopped();
    if (item.classList.contains('mail-item-checked')) return;
    await sleep(100);
  }

  throw new Error('Timed out while selecting QQ Mail item for deletion.');
}

async function deleteMailItem(item, mailId) {
  await ensureMailSelected(item);
  await sleep(250);

  const deleteBtn = findVisibleDeleteButton();
  if (!deleteBtn) {
    throw new Error('Could not find QQ Mail delete button.');
  }

  simulateClick(deleteBtn);
  log(`QQ Mail: Delete clicked for ${mailId}`);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    throwIfStopped();
    const stillExists = document.querySelector(`.mail-list-page-item[data-mailid="${CSS.escape(mailId)}"]`);
    if (!stillExists) return;
    await sleep(150);
  }

  throw new Error(`QQ Mail item ${mailId} did not disappear after delete.`);
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs } = payload;

  log(`Step ${step}: Starting email poll (max ${maxAttempts} attempts, every ${intervalMs / 1000}s)`);

  // Wait for mail list to load
  try {
    await waitForElement('.mail-list-page-item', 10000);
    log(`Step ${step}: Mail list loaded`);
  } catch {
    throw new Error('Mail list did not load. Make sure QQ Mail inbox is open.');
  }

  // Step 1: Snapshot existing mail IDs BEFORE we start waiting for new email
  const existingMailIds = getCurrentMailIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing emails as "old"`);

  // Keep a longer "new-mail-only" window first, then fallback only near the end.
  // This avoids selecting stale old/read emails before fresh verification mail arrives.
  const safeMaxAttempts = Math.max(1, Number(maxAttempts) || 1);
  const longWaitTarget = safeMaxAttempts >= 12
    ? Math.max(10, Math.floor(safeMaxAttempts * 0.6))
    : Math.max(3, Math.floor(safeMaxAttempts * 0.6));
  const FALLBACK_AFTER = safeMaxAttempts > 2
    ? Math.min(longWaitTarget, safeMaxAttempts - 2)
    : safeMaxAttempts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling QQ Mail... attempt ${attempt}/${maxAttempts}`);

    // Refresh inbox (skip on first attempt, list is fresh)
    if (attempt > 1) {
      await refreshInbox();
      await sleep(800);
    }

    const allItems = document.querySelectorAll('.mail-list-page-item[data-mailid]');
    const useFallback = attempt > FALLBACK_AFTER;

    // Phase 1 (attempt 1~3): only look at NEW emails (not in snapshot)
    // Phase 2 (attempt 4+): fallback to first matching email in list
    for (const item of allItems) {
      const mailId = item.getAttribute('data-mailid');

      const isOldMail = existingMailIds.has(mailId);
      if (!useFallback && isOldMail) continue;

      const meta = getMailItemMeta(item);
      const combinedLower = meta.combinedText.toLowerCase();
      const senderMatch = senderFilters.some(f => combinedLower.includes(String(f || '').toLowerCase()));
      const subjectMatch = subjectFilters.some(f => combinedLower.includes(String(f || '').toLowerCase()));

      if (senderMatch || subjectMatch) {
        const code = await extractCodeFromMailItem(item, step, meta);
        if (code) {
          // In fallback mode, only allow old mails that look unread to reduce stale-code risk.
          if (useFallback && isOldMail && !isLikelyUnreadMailItem(item)) {
            continue;
          }

          const source = useFallback && isOldMail ? 'fallback-unread-old' : 'new';
          try {
            await deleteMailItem(item, mailId);
            log(`Step ${step}: Deleted QQ Mail item ${mailId} after extracting code`, 'ok');
          } catch (deleteErr) {
            log(`Step ${step}: QQ Mail delete failed for ${mailId}: ${deleteErr.message}`, 'warn');
          }
          log(`Step ${step}: Code found: ${code} (${source}, subject: ${meta.subject.slice(0, 40)})`, 'ok');
          return { ok: true, code, emailTimestamp: Date.now(), mailId };
        }
      }
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new emails after ${FALLBACK_AFTER} attempts, fallback enabled (old mails must look unread)`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No new matching email found after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check QQ Mail manually. Email may be delayed or in spam folder.'
  );
}

function isLikelyUnreadMailItem(item) {
  if (!item) return false;

  const classText = String(item.className || '').toLowerCase();
  if (/unread|new|unseen|noread|未读/.test(classText)) return true;

  const subjectEl = item.querySelector('.mail-subject');
  if (subjectEl) {
    const fw = Number(window.getComputedStyle(subjectEl).fontWeight || 0);
    if (fw >= 600) return true;
  }

  if (item.querySelector('.mail-unread, .unread, .xmail-unread, [title*="未读"]')) {
    return true;
  }

  return false;
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox() {
  // Try multiple strategies to refresh the mail list

  // Strategy 1: Click any visible refresh button
  const refreshBtn = document.querySelector('[class*="refresh"], [title*="刷新"], [title*="Refresh" i], [aria-label*="Refresh" i]');
  if (refreshBtn) {
    simulateClick(refreshBtn);
    console.log(QQ_MAIL_PREFIX, 'Clicked refresh button');
    await sleep(500);
    return;
  }

  // Strategy 2: Click inbox in sidebar to reload list
  const sidebarInbox = document.querySelector('a[href*="inbox"], [class*="folder-item"][class*="inbox"], [title="收件箱"], [title="Inbox"], [aria-label*="Inbox" i]');
  if (sidebarInbox) {
    simulateClick(sidebarInbox);
    console.log(QQ_MAIL_PREFIX, 'Clicked sidebar inbox');
    await sleep(500);
    return;
  }

  // Strategy 3: Click the folder name in toolbar
  const folderName = document.querySelector('.toolbar-folder-name');
  if (folderName) {
    simulateClick(folderName);
    console.log(QQ_MAIL_PREFIX, 'Clicked toolbar folder name');
    await sleep(500);
  }
}

// ============================================================
// Verification Code Extraction
// ============================================================

function extractVerificationCode(text) {
  // Pattern 1: Chinese format "代码为 370794" or "验证码...370794"
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  // Pattern 2: English format "code is 370794" or "code: 370794"
  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  // Pattern 3: standalone 6-digit number (first occurrence)
  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}
