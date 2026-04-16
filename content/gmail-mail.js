// content/gmail-mail.js — Content script for Gmail (steps 4, 7)
// Injected on: mail.google.com
//
// Strategy:
// 1. Snapshot currently visible conversation IDs
// 2. Refresh the inbox and prioritize new matching threads
// 3. After a few attempts, fall back to the first matching visible row

const GMAIL_PREFIX = '[MultiPage:gmail-mail]';
const isTopFrame = window === window.top;

console.log(GMAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

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
    return true;
  }
});

function isVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return element.getClientRects().length > 0;
}

function getVisibleMailRows() {
  return Array.from(document.querySelectorAll('tr.zA')).filter(isVisible);
}

function getMailIdFromRow(row) {
  const threadNode = row.querySelector('.bqe[data-thread-id], .bqe[data-legacy-thread-id], [data-thread-id], [data-legacy-thread-id]');
  return (
    threadNode?.getAttribute('data-thread-id')
    || threadNode?.getAttribute('data-legacy-thread-id')
    || row.getAttribute('data-thread-id')
    || row.getAttribute('data-legacy-thread-id')
    || row.id
    || ''
  ).trim();
}

function getCurrentMailIds() {
  const ids = new Set();
  for (const row of getVisibleMailRows()) {
    const id = getMailIdFromRow(row);
    if (id) ids.add(id);
  }
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

function getRowText(row, selector) {
  return normalizeText(row.querySelector(selector)?.textContent || '');
}

function extractMailMeta(row) {
  const sender = getRowText(row, '.yW .zF, .yW .yP, .zF, .yP');
  const subject = getRowText(row, '.bog .bqe, .y6 .bqe, .bqe');
  const digest = getRowText(row, '.y2');
  const ariaLabelId = row.getAttribute('aria-labelledby');
  const ariaLabel = ariaLabelId
    ? normalizeText(document.getElementById(ariaLabelId)?.textContent || '')
    : '';
  const itemText = normalizeText(row.innerText || row.textContent || '');
  const titleTexts = [];

  const annotatedNodes = row.querySelectorAll('[title], [aria-label]');
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
    ariaLabel,
    itemText,
    titleTexts.join(' '),
  ].join(' '));

  return {
    sender,
    subject,
    digest,
    ariaLabel,
    combinedText,
    unread: row.classList.contains('zE'),
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

  document.querySelectorAll('.ii.gt .a3s.aiL, .a3s.aiL').forEach((el, index) => {
    pushCandidate(el.innerText || el.textContent || '', `gmail-body-${index}`);
  });

  const detailSelectors = [
    '.ii.gt .a3s.aiL',
    '.a3s.aiL',
    '.ii.gt',
    '[role="listitem"] .ii.gt',
    '[role="main"] .ii.gt',
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

async function extractCodeFromOpenedMail(row, step, meta = {}) {
  const clickTarget = row.querySelector('.bog, .y6, .zA .xS') || row;
  simulateClick(clickTarget);
  await sleep(500);

  for (let attempt = 1; attempt <= 8; attempt++) {
    throwIfStopped();
    const candidates = collectOpenedMailTextCandidates(meta);
    for (const candidate of candidates) {
      const code = extractVerificationCode(candidate.text);
      if (code) {
        log(`Step ${step}: Code found from opened Gmail body (${candidate.source})`, 'ok');
        return code;
      }
    }
    await sleep(300);
  }

  return null;
}

async function extractCodeFromMailRow(row, step, meta = {}) {
  const inlineCode = extractVerificationCode(meta.combinedText || '');
  if (inlineCode) {
    return inlineCode;
  }

  log(`Step ${step}: Gmail row matched filters but list text had no code. Opening email body...`, 'info');
  return await extractCodeFromOpenedMail(row, step, meta);
}

function triggerRowHover(row) {
  row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
}

function findVisibleRowDeleteButton(row) {
  const buttons = row.querySelectorAll('li.bru[data-tooltip], li.bru');
  for (const button of buttons) {
    if (isVisible(button)) return button;
  }
  return null;
}

function findTopToolbarDeleteButton() {
  const candidates = document.querySelectorAll([
    'div[role="button"][aria-label*="删除"]',
    'div[role="button"][data-tooltip*="删除"]',
    'div[role="button"][aria-label*="Delete"]',
    'div[role="button"][data-tooltip*="Delete"]',
    'div[role="button"][aria-label*="刪除"]',
    'div[role="button"][data-tooltip*="刪除"]',
    'div[act="10"]',
    '.T-I.nX[role="button"]',
  ].join(', '));

  for (const button of candidates) {
    if (isVisible(button) && button.getAttribute('aria-disabled') !== 'true') {
      return button;
    }
  }
  return null;
}

async function ensureMailSelected(row) {
  const checkbox = row.querySelector('.oZ-jc[role="checkbox"]');
  if (!checkbox) {
    throw new Error('Could not find Gmail row checkbox.');
  }

  if (checkbox.getAttribute('aria-checked') === 'true') return;

  simulateClick(checkbox);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    throwIfStopped();
    if (checkbox.getAttribute('aria-checked') === 'true') return;
    await sleep(100);
  }

  throw new Error('Timed out while selecting Gmail row for deletion.');
}

async function deleteGmailItem(row, mailId) {
  triggerRowHover(row);
  await sleep(250);

  const rowDeleteButton = findVisibleRowDeleteButton(row);
  if (rowDeleteButton) {
    simulateClick(rowDeleteButton);
    log(`Gmail: Row delete clicked for ${mailId}`);
  } else {
    await ensureMailSelected(row);
    await sleep(250);

    const toolbarDelete = findTopToolbarDeleteButton();
    if (!toolbarDelete) {
      throw new Error('Could not find Gmail delete button.');
    }

    simulateClick(toolbarDelete);
    log(`Gmail: Toolbar delete clicked for ${mailId}`);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    throwIfStopped();
    const stillExists = getVisibleMailRows().some(currentRow => getMailIdFromRow(currentRow) === mailId);
    if (!stillExists) return;
    await sleep(150);
  }

  throw new Error(`Gmail row ${mailId} did not disappear after delete.`);
}

function findRefreshButton() {
  const candidates = document.querySelectorAll([
    'div[role="button"][aria-label*="刷新"]',
    'div[role="button"][data-tooltip*="刷新"]',
    'div[role="button"][aria-label*="Refresh"]',
    'div[role="button"][data-tooltip*="Refresh"]',
    'div[role="button"][aria-label*="重新整理"]',
    'div[role="button"][data-tooltip*="重新整理"]',
    'div[act="20"]',
    '.T-I.nu[role="button"]',
  ].join(', '));

  for (const button of candidates) {
    if (isVisible(button) && button.getAttribute('aria-disabled') !== 'true') {
      return button;
    }
  }
  return null;
}

async function refreshInbox() {
  const refreshButton = findRefreshButton();
  if (!refreshButton) {
    log('Gmail: Could not find refresh button. Relying on auto-refresh...', 'warn');
    return;
  }

  simulateClick(refreshButton);
  log('Gmail: Refresh clicked');
  await sleep(1500);
}

function extractVerificationCode(text) {
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  return null;
}

function isLikelyUnreadMailRow(row, meta) {
  if (!row) return false;

  // Gmail unread row marker
  if (row.classList.contains('zE')) return true;

  const classText = String(row.className || '').toLowerCase();
  if (/unread|new|unseen|未读/.test(classText)) return true;

  const aria = String(meta?.ariaLabel || row.getAttribute('aria-label') || '').toLowerCase();
  if (/未读|unread|new message/.test(aria)) return true;

  return false;
}

function rowMatchesFilters(meta, senderFilters, subjectFilters) {
  const senderText = `${meta.sender} ${meta.ariaLabel} ${meta.combinedText}`.toLowerCase();
  const subjectText = `${meta.subject} ${meta.digest} ${meta.ariaLabel} ${meta.combinedText}`.toLowerCase();
  const senderMatch = senderFilters.some(filter => senderText.includes(String(filter || '').toLowerCase()));
  const subjectMatch = subjectFilters.some(filter => subjectText.includes(String(filter || '').toLowerCase()));
  return senderMatch || subjectMatch;
}

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs } = payload;

  log(`Step ${step}: Starting email poll on Gmail (max ${maxAttempts} attempts, every ${intervalMs / 1000}s)`);

  try {
    await waitForElement('table.F.cf.zt, tr.zA', 15000);
    log(`Step ${step}: Gmail list loaded`);
  } catch {
    throw new Error('Gmail list did not load. Make sure Gmail inbox or Primary tab is open.');
  }

  const existingMailIds = getCurrentMailIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} visible emails as "old"`);

  // Keep a longer new-mail-only phase; fallback only near the end.
  // This reduces stale-code risk when new mail arrives with delay.
  const safeMaxAttempts = Math.max(1, Number(maxAttempts) || 1);
  const longWaitTarget = safeMaxAttempts >= 12
    ? Math.max(10, Math.floor(safeMaxAttempts * 0.6))
    : Math.max(3, Math.floor(safeMaxAttempts * 0.6));
  const FALLBACK_AFTER = safeMaxAttempts > 2
    ? Math.min(longWaitTarget, safeMaxAttempts - 2)
    : safeMaxAttempts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling Gmail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshInbox();
    }

    const useFallback = attempt > FALLBACK_AFTER;
    const rows = getVisibleMailRows();
    const orderedRows = [
      ...rows.filter(row => row.classList.contains('zE')),
      ...rows.filter(row => !row.classList.contains('zE')),
    ];

    for (const row of orderedRows) {
      const mailId = getMailIdFromRow(row);
      if (!mailId) continue;

      const isOldMail = existingMailIds.has(mailId);
      if (!useFallback && isOldMail) continue;

      const meta = extractMailMeta(row);
      if (!rowMatchesFilters(meta, senderFilters, subjectFilters)) continue;

      const code = await extractCodeFromMailRow(row, step, meta);
      if (!code) continue;

      // In fallback mode, only accept old mails that still look unread.
      if (useFallback && isOldMail && !isLikelyUnreadMailRow(row, meta)) continue;

      const source = useFallback && isOldMail ? 'fallback-unread-old' : 'new';
      try {
        await deleteGmailItem(row, mailId);
        log(`Step ${step}: Deleted Gmail item ${mailId} after extracting code`, 'ok');
      } catch (deleteErr) {
        log(`Step ${step}: Gmail delete failed for ${mailId}: ${deleteErr.message}`, 'warn');
      }

      log(`Step ${step}: Code found: ${code} (${source}, subject: ${meta.subject.slice(0, 60)})`, 'ok');
      return { ok: true, code, emailTimestamp: Date.now(), mailId };
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new Gmail emails after ${FALLBACK_AFTER} attempts, fallback enabled (old mails must look unread)`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No new matching email found on Gmail after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check Gmail manually and make sure the inbox or Primary tab is visible.'
  );
}
