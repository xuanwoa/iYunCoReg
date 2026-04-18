// content/mail-163.js — Content script for 163 Mail (steps 4, 7)
// Injected on: mail.163.com
//
// DOM structure:
// Mail item: div[sign="letter"] with aria-label="你的 ChatGPT 代码为 479637 发件人 ： OpenAI ..."
// Sender: .nui-user (e.g., "OpenAI")
// Subject: span.da0 (e.g., "你的 ChatGPT 代码为 479637")
// Right-click menu: .nui-menu → .nui-menu-item with text "删除邮件"

const MAIL163_PREFIX = '[MultiPage:mail-163]';
const isTopFrame = window === window.top;

console.log(MAIL163_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// Only operate in the top frame
if (!isTopFrame) {
  console.log(MAIL163_PREFIX, 'Skipping child frame');
} else {

// ============================================================
// Message Handler (top frame only)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
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

// ============================================================
// Find mail items
// ============================================================

function findMailItems() {
  const visibleListModules = [...document.querySelectorAll('div[id^="_dvModuleContainer_mbox.ListModule_"]')]
    .filter(isElementVisible);

  for (const moduleEl of visibleListModules) {
    const scopedItems = [...moduleEl.querySelectorAll('div[sign="letter"]')]
      .filter(isElementVisible);
    if (scopedItems.length > 0) {
      return scopedItems;
    }
  }

  const visibleItems = [...document.querySelectorAll('div[sign="letter"]')]
    .filter(isElementVisible);
  if (visibleItems.length > 0) {
    return visibleItems;
  }

  return [...document.querySelectorAll('div[sign="letter"]')];
}

function getCurrentMailIds() {
  const ids = new Set();
  findMailItems().forEach(item => {
    const id = item.getAttribute('id') || '';
    if (id) ids.add(id);
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
  const sender = normalizeText(item.querySelector('.nui-user')?.textContent || '');
  const subject = normalizeText(item.querySelector('span.da0')?.textContent || '');
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
    itemText,
    ariaLabel,
    titleTexts.join(' '),
  ].join(' '));

  const routingText = normalizeText([
    ariaLabel,
    itemText,
    titleTexts.join(' '),
  ].join(' '));
  const hasIncomingHints = /(发件人|代发|\bfrom\b|\bsender\b)/i.test(routingText);
  const hasOutgoingHints = /(收件人|发送成功|再次编辑发送|\brecipient\b|\bsent\b)/i.test(routingText);
  const direction = hasOutgoingHints && !hasIncomingHints ? 'outgoing' : 'incoming';

  return {
    sender,
    subject,
    combinedText,
    direction,
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

function isElementVisible(el) {
  if (!el || !document.documentElement.contains(el)) return false;

  try {
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
  } catch {}

  const rect = el.getBoundingClientRect?.();
  if (!rect) return true;
  return rect.width > 0 && rect.height > 0;
}

function getReadModuleSubject(moduleEl) {
  if (!moduleEl) return '';

  const subjectEl = moduleEl.querySelector('h1[id$="_h1Subject"], h1[title="邮件标题"], h1[title="Mail subject"]');
  return normalizeText(subjectEl?.textContent || '');
}

function getActiveReadTabTitle() {
  const activeTab = document.querySelector('.nui-tabs-item-selected[role="tab"], [aria-selected="true"][role="tab"]');
  if (!activeTab) return '';

  return normalizeText(
    readAttr(activeTab, 'title') ||
    activeTab.querySelector('.nui-tabs-item-text')?.textContent ||
    activeTab.textContent ||
    ''
  );
}

function collectOpenedMailTextCandidates(meta = {}) {
  const candidates = [];
  const seen = new Set();
  const activeReadTabTitle = getActiveReadTabTitle().toLowerCase();

  function pushCandidate(text, source, bonus = 0) {
    const normalized = normalizeText(text);
    if (!normalized || normalized.length < 6) return;
    const key = `${source}:${normalized.slice(0, 400)}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      source,
      text: normalized,
      score: scoreOpenedMailText(normalized, meta) + bonus,
    });
  }

  const readModules = [...document.querySelectorAll('div[id^="_dvModuleContainer_read.ReadModule_"]')];
  const visibleReadModules = readModules.filter(isElementVisible);

  for (const [index, moduleEl] of visibleReadModules.entries()) {
    const moduleSubject = getReadModuleSubject(moduleEl);
    const moduleSubjectLower = moduleSubject.toLowerCase();
    const tabSubjectBonus = moduleSubjectLower && activeReadTabTitle && moduleSubjectLower === activeReadTabTitle ? 12 : 0;
    const moduleBonus = 28 + tabSubjectBonus;

    pushCandidate(
      [
        moduleSubject,
        moduleEl.querySelector('ul[id$="_ulFull"]')?.innerText || '',
        moduleEl.querySelector('div[id$="_dvContent"]')?.innerText || '',
      ].join(' '),
      `visible-read-module-${index}`,
      moduleBonus
    );

    moduleEl.querySelectorAll('iframe[id$="_frameBody"]').forEach((frame, frameIndex) => {
      try {
        const frameBody = frame.contentDocument?.body;
        if (!frameBody) return;
        pushCandidate(
          [moduleSubject, frameBody.innerText || frameBody.textContent || ''].join(' '),
          `visible-read-frame-${index}-${frameIndex}`,
          moduleBonus + 24
        );
      } catch {}
    });
  }

  document.querySelectorAll('div[data-nds-name="main"]').forEach((el, index) => {
    const enclosingVisibleModule = el.closest('div[id^="_dvModuleContainer_read.ReadModule_"]');
    const bonus = enclosingVisibleModule && isElementVisible(enclosingVisibleModule) ? 18 : 0;
    pushCandidate(el.innerText || el.textContent || '', `nds-main-${index}`, bonus);
  });

  document.querySelectorAll([
    'div[data-nds-name="main"] .main',
    'div[data-nds-name="main"] p',
    'div[data-nds-name="main"] h1',
    'div[data-nds-name="main"] h2',
    'div[data-nds-name="main"] h3',
    'div[data-nds-name="main"] td',
    'div[data-nds-name="main"] div',
    'div[data-nds-name="main"] span',
  ].join(', ')).forEach((el, index) => {
    const enclosingVisibleModule = el.closest('div[id^="_dvModuleContainer_read.ReadModule_"]');
    const bonus = enclosingVisibleModule && isElementVisible(enclosingVisibleModule) ? 14 : 0;
    pushCandidate(el.innerText || el.textContent || '', `nds-block-${index}`, bonus);
  });

  const detailSelectors = [
    'div[data-nds-name="main"]',
    '[class*="mailview" i]',
    '[class*="mail-view" i]',
    '[class*="mailcontent" i]',
    '[class*="mail-content" i]',
    '[class*="mailread" i]',
    '[class*="mail-read" i]',
    '[class*="reader" i]',
    '[role="document"]',
  ];

  document.querySelectorAll(detailSelectors.join(', ')).forEach((el, index) => {
    const enclosingVisibleModule = el.closest('div[id^="_dvModuleContainer_read.ReadModule_"]');
    const bonus = enclosingVisibleModule && isElementVisible(enclosingVisibleModule) ? 12 : 0;
    pushCandidate(el.innerText || el.textContent || '', `detail-${index}`, bonus);
  });

  document.querySelectorAll('iframe').forEach((frame, index) => {
    try {
      const frameDoc = frame.contentDocument;
      const frameBody = frameDoc?.body;
      if (!frameBody) return;
      const readModule = frame.closest('div[id^="_dvModuleContainer_read.ReadModule_"]');
      const visibleBonus = readModule && isElementVisible(readModule) ? 24 : 0;
      const frameBodyBonus = /_frameBody$/i.test(frame.id || '') ? 8 : 0;
      const moduleSubject = getReadModuleSubject(readModule);
      const tabSubjectBonus =
        moduleSubject &&
        activeReadTabTitle &&
        moduleSubject.toLowerCase() === activeReadTabTitle
          ? 10
          : 0;
      pushCandidate(
        [moduleSubject, frameBody.innerText || frameBody.textContent || ''].join(' '),
        `iframe-${index}`,
        visibleBonus + frameBodyBonus + tabSubjectBonus
      );
    } catch {}
  });

  return candidates.sort((a, b) => (b.score - a.score) || (b.text.length - a.text.length));
}

function getCandidateSignature(candidate) {
  return `${candidate?.source || 'unknown'}:${normalizeText(candidate?.text || '').slice(0, 240)}`;
}

function getMailMetaTokens(meta = {}) {
  return normalizeText(`${meta.sender || ''} ${meta.subject || ''}`)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter(token => token.length >= 2);
}

function candidateMatchesMailMeta(candidate, meta = {}) {
  const normalized = normalizeText(candidate?.text || '');
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  const sender = normalizeText(meta.sender || '').toLowerCase();
  if (sender && lower.includes(sender)) {
    return true;
  }

  const tokens = getMailMetaTokens(meta);
  let matchedTokens = 0;
  for (const token of tokens.slice(0, 10)) {
    if (lower.includes(token)) {
      matchedTokens += 1;
      if (matchedTokens >= 2) {
        return true;
      }
    }
  }

  return candidate.score >= 18;
}

function dedupeCandidates(candidates = []) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    const signature = getCandidateSignature(candidate);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(candidate);
  }
  return deduped;
}

async function clickMailItemForReading(item) {
  const clickTargets = [
    item.querySelector('span.da0'),
    item.querySelector('.nui-user'),
    item,
  ].filter(Boolean);

  for (const target of clickTargets) {
    try {
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch {}

    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));

    try {
      if (typeof target.click === 'function') {
        target.click();
      } else {
        simulateClick(target);
      }
    } catch {
      simulateClick(target);
    }

    await sleep(180);
  }
}

async function extractCodeFromOpenedMail(item, step, meta = {}) {
  const baselineCandidates = collectOpenedMailTextCandidates(meta);
  const baselineSignatures = new Set(baselineCandidates.map(getCandidateSignature));
  let changedAfterOpen = false;

  await clickMailItemForReading(item);
  await sleep(700);

  let bestCandidate = null;
  for (let attempt = 1; attempt <= 24; attempt++) {
    throwIfStopped();
    const candidates = collectOpenedMailTextCandidates(meta);
    const changedCandidates = candidates.filter(candidate => !baselineSignatures.has(getCandidateSignature(candidate)));
    if (changedCandidates.length > 0) {
      changedAfterOpen = true;
    }

    const relatedCandidates = candidates.filter(candidate => candidateMatchesMailMeta(candidate, meta));
    const prioritizedCandidates = dedupeCandidates([
      ...changedCandidates.filter(candidate => candidateMatchesMailMeta(candidate, meta)),
      ...relatedCandidates,
      ...(attempt >= 12 ? changedCandidates : []),
      ...(attempt >= 18 ? candidates : []),
    ]);

    if (!bestCandidate) {
      bestCandidate = prioritizedCandidates[0] || changedCandidates[0] || candidates[0] || null;
    }

    for (const candidate of prioritizedCandidates) {
      const code = extractVerificationCode(candidate.text);
      if (code) {
        log(`Step ${step}: Code found from opened 163 mail body (${candidate.source})`, 'ok');
        return code;
      }
    }

    if (attempt === 4 || attempt === 8 || attempt === 14) {
      await clickMailItemForReading(item);
    }

    await sleep(300);
  }

  if (bestCandidate?.text) {
    log(
      `Step ${step}: Opened 163 mail body ${changedAfterOpen ? 'changed' : 'did not clearly change'} but no code was parsed. Sample (${bestCandidate.source}): ${bestCandidate.text.slice(0, 220)}`,
      'warn'
    );
  }

  return null;
}

async function extractCodeFromMailItem(item, step, meta = {}) {
  return extractVerificationCode(meta.combinedText || '');
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs } = payload;

  log(`Step ${step}: Starting email poll on 163 Mail (max ${maxAttempts} attempts)`);

  // Click inbox in sidebar to ensure we're in inbox view
  log(`Step ${step}: Waiting for sidebar...`);
  try {
    const inboxLink = await waitForElement('.nui-tree-item-text[title="收件箱"], .nui-tree-item-text[title="Inbox"]', 5000);
    inboxLink.click();
    log(`Step ${step}: Clicked inbox`);
  } catch {
    log(`Step ${step}: Inbox link not found, proceeding...`, 'warn');
  }

  // Wait for mail list to appear
  log(`Step ${step}: Waiting for mail list...`);
  let items = [];
  for (let i = 0; i < 20; i++) {
    items = findMailItems();
    if (items.length > 0) break;
    await sleep(500);
  }

  if (items.length === 0) {
    await refreshInbox();
    await sleep(2000);
    items = findMailItems();
  }

  if (items.length === 0) {
    throw new Error('163 Mail list did not load. Make sure inbox is open.');
  }

  log(`Step ${step}: Mail list loaded, ${items.length} items`);

  // Snapshot existing mail IDs
  const existingMailIds = getCurrentMailIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing emails`);

  // Keep a longer new-mail-only phase; fallback only near the end.
  // This reduces grabbing stale old/read emails before the fresh code arrives.
  const safeMaxAttempts = Math.max(1, Number(maxAttempts) || 1);
  const longWaitTarget = safeMaxAttempts >= 12
    ? Math.max(10, Math.floor(safeMaxAttempts * 0.6))
    : Math.max(3, Math.floor(safeMaxAttempts * 0.6));
  const FALLBACK_AFTER = safeMaxAttempts > 2
    ? Math.min(longWaitTarget, safeMaxAttempts - 2)
    : safeMaxAttempts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling 163 Mail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshInbox();
      await sleep(1000);
    }

    const allItems = findMailItems();
    const useFallback = attempt > FALLBACK_AFTER;

    for (const item of allItems) {
      const id = item.getAttribute('id') || '';

      const isOldMail = existingMailIds.has(id);
      if (!useFallback && isOldMail) continue;

      const meta = getMailItemMeta(item);
      if (meta.direction === 'outgoing') {
        continue;
      }

      const combinedLower = meta.combinedText.toLowerCase();
      const senderMatch = senderFilters.some(f => combinedLower.includes(String(f || '').toLowerCase()));
      const subjectMatch = subjectFilters.some(f => combinedLower.includes(String(f || '').toLowerCase()));

      if (senderMatch || subjectMatch) {
        const code = await extractCodeFromMailItem(item, step, meta);
        if (code && !seenCodes.has(code)) {
          // In fallback mode, only accept old mails that look unread.
          if (useFallback && isOldMail && !isLikelyUnreadMailItem(item, ariaLabel)) {
            continue;
          }

          seenCodes.add(code);
          persistSeenCodes();
          const source = useFallback && isOldMail ? 'fallback-unread-old' : 'new';
          log(`Step ${step}: Code found: ${code} (${source}, subject: ${meta.subject.slice(0, 40)})`, 'ok');

          // Delete this email via right-click menu, WAIT for it to finish before returning
          await deleteEmail(item, step);
          // Extra wait to ensure deletion is processed
          await sleep(1000);

          return { ok: true, code, emailTimestamp: Date.now(), mailId: id };
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
    `No new matching email found on 163 Mail after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check inbox manually.'
  );
}

function isLikelyUnreadMailItem(item, ariaLabel = '') {
  if (!item) return false;

  const classText = String(item.className || '').toLowerCase();
  if (/unread|new|unseen|noread|未读/.test(classText)) return true;

  const aria = String(ariaLabel || item.getAttribute('aria-label') || '').toLowerCase();
  if (/未读|unread|新邮件/.test(aria)) return true;

  if (item.querySelector('.unread, .nui-ico-unread, [title*="未读"]')) {
    return true;
  }

  return false;
}

// ============================================================
// Delete Email via Right-Click Menu
// ============================================================

async function deleteEmail(item, step) {
  try {
    log(`Step ${step}: Deleting email...`);

    // Strategy 1: Click the trash icon inside the mail item
    // Each mail item has: <b class="nui-ico nui-ico-delete" title="删除邮件" sign="trash">
    // These icons appear on hover, so we trigger mouseover first
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await sleep(300);

    const trashIcon = item.querySelector('[sign="trash"], .nui-ico-delete, [title="删除邮件"], [title="Delete email"], [title*="delete" i]');
    if (trashIcon) {
      trashIcon.click();
      log(`Step ${step}: Clicked trash icon`, 'ok');
      await sleep(1500);

      // Check if item disappeared (confirm deletion)
      const stillExists = document.getElementById(item.id);
      if (!stillExists || stillExists.style.display === 'none') {
        log(`Step ${step}: Email deleted successfully`);
      } else {
        log(`Step ${step}: Email may not have been deleted, item still visible`, 'warn');
      }
      return;
    }

    // Strategy 2: Select checkbox then click toolbar delete button
    log(`Step ${step}: Trash icon not found, trying checkbox + toolbar delete...`);
    const checkbox = item.querySelector('[sign="checkbox"], .nui-chk');
    if (checkbox) {
      checkbox.click();
      await sleep(300);

      // Click toolbar delete button
      const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
      for (const btn of toolbarBtns) {
        const text = btn.textContent.replace(/\s/g, '');
        if (/删除|delete/i.test(text)) {
          btn.closest('.nui-btn').click();
          log(`Step ${step}: Clicked toolbar delete`, 'ok');
          await sleep(1500);
          return;
        }
      }
    }

    log(`Step ${step}: Could not delete email (no delete button found)`, 'warn');
  } catch (err) {
    log(`Step ${step}: Failed to delete email: ${err.message}`, 'warn');
  }
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox() {
  // Try toolbar "刷 新" button
  const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
  for (const btn of toolbarBtns) {
    const text = btn.textContent.replace(/\s/g, '');
    if (/^刷新$|^refresh$/i.test(text)) {
      btn.closest('.nui-btn').click();
      console.log(MAIL163_PREFIX, 'Clicked "刷新" button');
      await sleep(800);
      return;
    }
  }

  // Fallback: click sidebar "收 信"
  const shouXinBtns = document.querySelectorAll('.ra0');
  for (const btn of shouXinBtns) {
    const text = btn.textContent.replace(/\s/g, '');
    if (/收信|inbox|receive/i.test(text)) {
      btn.click();
      console.log(MAIL163_PREFIX, 'Clicked "收信" button');
      await sleep(800);
      return;
    }
  }

  console.log(MAIL163_PREFIX, 'Could not find refresh button');
}

// ============================================================
// Verification Code Extraction
// ============================================================

function extractVerificationCode(text) {
  const matchCnExtended = text.match(
    /(?:输入此(?:临时)?验证码(?:以继续)?|输入此(?:临时)?代码(?:以继续)?|临时验证码|登录代码|验证码|代码为)[^\d]{0,40}(\d{6})/
  );
  if (matchCnExtended) return matchCnExtended[1];

  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEnExtended = text.match(
    /(?:enter this (?:temporary )?(?:verification )?code(?: to continue)?|if that was you,\s*enter this code)[^\d]{0,40}(\d{6})/i
  );
  if (matchEnExtended) return matchEnExtended[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

} // end of isTopFrame else block
