const BLOCKED_KEYWORDS = ['roblox'];

const blockedVideoIds = window.tizentubeBlockedVideoIds || new Set();
window.tizentubeBlockedVideoIds = blockedVideoIds;

let lastBlockedNavigationAt = 0;
let hasShownActiveToast = false;
let domFilterStarted = false;
let hiddenDomTileCount = 0;

function textFromNode(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.simpleText) return String(node.simpleText);
  if (Array.isArray(node.runs)) {
    return node.runs.map(run => run?.text || '').join('');
  }
  return '';
}

function containsBlockedKeyword(text) {
  const normalized = String(text || '').toLowerCase();
  return BLOCKED_KEYWORDS.some(keyword => normalized.includes(keyword.toLowerCase()));
}

function rememberBlockedVideoId(videoId) {
  if (videoId) blockedVideoIds.add(videoId);
}

function isBlockedVideoId(videoId) {
  return Boolean(videoId && blockedVideoIds.has(videoId));
}

function getTileTitle(item) {
  return textFromNode(item?.tileRenderer?.metadata?.tileMetadataRenderer?.title);
}

function getTileVideoId(item) {
  return item?.tileRenderer?.contentId || item?.tileRenderer?.onSelectCommand?.watchEndpoint?.videoId;
}

function rendererContainsBlockedKeyword(renderer) {
  try {
    return containsBlockedKeyword(JSON.stringify(renderer));
  } catch (e) {
    return false;
  }
}

function isBlockedTile(item) {
  const title = getTileTitle(item);
  if (!containsBlockedKeyword(title) && !rendererContainsBlockedKeyword(item?.tileRenderer)) return false;

  rememberBlockedVideoId(getTileVideoId(item));
  return true;
}

function filterBlockedTiles(items) {
  if (!Array.isArray(items)) return items;
  return items.filter(item => !isBlockedTile(item));
}

function getWatchMetadata(response) {
  const contents = response?.contents?.singleColumnWatchNextResults?.results?.results?.contents;
  if (!Array.isArray(contents)) return null;

  for (const section of contents) {
    const sectionContents = section?.itemSectionRenderer?.contents;
    if (!Array.isArray(sectionContents)) continue;

    for (const item of sectionContents) {
      if (item?.videoMetadataRenderer) return item.videoMetadataRenderer;
    }
  }

  return null;
}

function findBlockedPlayback(response) {
  const detailsTitle = response?.videoDetails?.title;
  if (containsBlockedKeyword(detailsTitle)) {
    return {
      videoId: response?.videoDetails?.videoId,
      title: detailsTitle
    };
  }

  const metadata = getWatchMetadata(response);
  const metadataTitle = textFromNode(metadata?.title);
  if (containsBlockedKeyword(metadataTitle)) {
    return {
      videoId: metadata?.videoId,
      title: metadataTitle
    };
  }

  return null;
}

function stopBlockedPlayback(title) {
  try {
    const video = document.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  } catch (e) {
    console.warn('Failed to stop blocked video playback:', e);
  }

  try {
    const subtitle = title ? `Blocked video: ${title}` : 'Blocked video';
    window.tizentubeShowToast?.('TizenTube', subtitle);
  } catch (e) {
    console.warn('Failed to show blocked video toast:', e);
  }

  const now = Date.now();
  if (now - lastBlockedNavigationAt < 3000) return;
  lastBlockedNavigationAt = now;

  setTimeout(() => {
    try {
      if (location.hash.indexOf('/watch') !== -1 && window.history.length > 1) {
        window.history.back();
      }
    } catch (e) {
      console.warn('Failed to navigate away from blocked video:', e);
    }
  }, 100);
}

function handlePlaybackResponse(response) {
  const blockedPlayback = findBlockedPlayback(response);
  if (!blockedPlayback) return false;

  rememberBlockedVideoId(blockedPlayback.videoId);
  response.streamingData = null;
  response.playabilityStatus = {
    status: 'ERROR',
    reason: 'Blocked by TizenTube'
  };
  setTimeout(() => stopBlockedPlayback(blockedPlayback.title), 0);
  return true;
}

function hideElement(element) {
  element.setAttribute('data-tizentube-blocked-title', 'true');
  element.style.setProperty('display', 'none', 'important');
  element.style.setProperty('visibility', 'hidden', 'important');
}

function looksLikeVideoResult(element) {
  const text = element?.textContent || '';
  const rect = element?.getBoundingClientRect?.();
  if (!rect || rect.width < 100 || rect.height < 60) return false;
  if (!containsBlockedKeyword(text)) return false;
  return /views?|ago|\d+:\d+|watch/i.test(text);
}

function findBlockedDomTileFromTextNode(textNode) {
  let element = textNode.parentElement;
  for (let depth = 0; element && depth < 12; depth++) {
    if (looksLikeVideoResult(element)) return element;
    element = element.parentElement;
  }
  return null;
}

function hideBlockedRendererElements() {
  let count = 0;
  const candidates = document.querySelectorAll([
    'ytlr-tile-renderer',
    'ytlr-video-renderer',
    'ytlr-compact-video-renderer',
    'ytlr-grid-video-renderer',
    'ytlr-search-video-renderer',
    'ytlr-lockup-view-model',
    '[is="ytlr-tile-renderer"]',
    '[role="link"]',
    '[role="button"]',
    '[tabindex]',
    '[hybridnavfocusable]'
  ].join(','));

  for (const element of candidates) {
    if (element.getAttribute('data-tizentube-blocked-title') === 'true') continue;
    if (!looksLikeVideoResult(element)) continue;
    hideElement(element);
    count++;
  }

  return count;
}

function hideBlockedTextNodeElements() {
  if (!document.body) return 0;

  let count = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!containsBlockedKeyword(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('input, textarea')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const matches = [];
  while (walker.nextNode()) {
    matches.push(walker.currentNode);
  }

  for (const node of matches) {
    const element = findBlockedDomTileFromTextNode(node);
    if (!element) continue;
    if (element.getAttribute('data-tizentube-blocked-title') === 'true') continue;
    hideElement(element);
    count++;
  }

  return count;
}

function hideBlockedDomTiles() {
  const count = hideBlockedRendererElements() + hideBlockedTextNodeElements();

  if (count > 0) {
    hiddenDomTileCount += count;
    try {
      window.tizentubeShowToast?.('TizenTube Roblox Filter', `Hidden ${hiddenDomTileCount} blocked video${hiddenDomTileCount === 1 ? '' : 's'}`);
    } catch (e) { }
  }
}

function stopBlockedDomClicks() {
  document.addEventListener('click', event => {
    const element = event.target?.closest?.('[data-tizentube-blocked-title="true"]');
    if (!element) return;
    if (!containsBlockedKeyword(element.textContent)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function startBlockedTitleDomFilter() {
  if (domFilterStarted) return;
  domFilterStarted = true;

  setTimeout(() => {
    try {
      if (!hasShownActiveToast) {
        hasShownActiveToast = true;
        window.tizentubeShowToast?.('TizenTube Roblox Filter', 'Blocked-title filter active');
      }
    } catch (e) { }
  }, 2500);

  const runFilter = () => {
    try {
      hideBlockedDomTiles();
    } catch (e) {
      console.warn('Blocked title DOM filter failed:', e);
    }
  };

  setInterval(runFilter, 1000);
  stopBlockedDomClicks();

  const startObserver = () => {
    if (!document.body) return setTimeout(startObserver, 250);

    const observer = new MutationObserver(runFilter);
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    runFilter();
  };

  startObserver();
}

export {
  containsBlockedKeyword,
  filterBlockedTiles,
  handlePlaybackResponse,
  isBlockedVideoId,
  rememberBlockedVideoId,
  startBlockedTitleDomFilter,
  stopBlockedPlayback,
  textFromNode
};
