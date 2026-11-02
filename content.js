/**
 * LinkedIn Comment Generator - Universal Content Script
 * Works on Home Feed, Personal Profile Activity, Company Posts & Single Post Views
 */
(function () {
    // Purane timers aur UI elements ko clean karein
    if (window._lcgInterval) {
        clearInterval(window._lcgInterval);
    }
    if (window._lcgObserver) {
        window._lcgObserver.disconnect();
    }
    document.querySelectorAll('.linkedin-comment-generator-container, .linkedin-comment-generator-ui').forEach(el => el.remove());

    const debug = {
        enabled: false,
        isDebugMode: false,
        log: (message, data = null) => {
            if (!debug.enabled && !debug.isDebugMode) return;
            console.log(`[LinkedIn Comment Generator] ${message}`, data || '');
        },
        error: (message, error = null) => {
            console.error(`[LinkedIn Comment Generator] ${message}`, error || '');
        }
    };

    // Local Docker n8n configuration
    const API_CONFIG = {
        URL: 'http://localhost:5678/webhook/ai-agent-webhook',
        MAX_RETRIES: 2,
        TIMEOUT_MS: 25000
    };

    // Local Ollama model configuration
    const GPT_MODELS = {
        MODELS: [
            { value: 'qwen2.5:7b', label: 'Qwen 2.5 (7B)', apiName: 'qwen2.5:7b' }
        ],
        getApiName: function (modelValue) {
            const model = this.MODELS.find(m => m.value === modelValue);
            return model ? model.apiName : 'qwen2.5:7b';
        },
        getDisplayLabel: function (modelValue) {
            const model = this.MODELS.find(m => m.value === modelValue);
            return model ? model.label : 'Qwen 2.5 (7B)';
        }
    };

    let activeCommentUI = null;

    /**
     * Check karta hai ki element video player control bar ke andar toh nahi hai
     */
    function isInsideVideoPlayer(el) {
        if (!el) return false;
        if (el.closest('.vjs-control-bar, .media-player, [data-view-name*="video"]')) {
            return true;
        }

        const r = el.getBoundingClientRect();
        const midY = (r.top + r.bottom) / 2;
        const videos = document.querySelectorAll('video');

        for (const v of videos) {
            const vr = v.getBoundingClientRect();
            if (vr.width > 40 && vr.height > 40) {
                if (midY >= vr.top - 4 && midY <= vr.bottom + 4 && r.left >= vr.left - 20 && r.right <= vr.right + 20) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Check karta hai ki element screen-reader-only (.visually-hidden / 1x1px clipped) hai ya hidden hai
     * Note: [aria-hidden="true"] ko block NAHI karna hai kyunki LinkedIn visible post caption usi me rakhta hai
     */
    function isHiddenOrScreenReaderOnly(el, stopAt = null) {
        let curr = el;
        while (curr && curr !== document.body && curr !== stopAt) {
            if (
                curr.classList &&
                (curr.classList.contains('visually-hidden') ||
                    curr.classList.contains('a11y-text') ||
                    curr.classList.contains('sr-only'))
            ) {
                return true;
            }

            const style = window.getComputedStyle(curr);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                return true;
            }

            // Screen reader 1x1px clipped spans ko skip karein
            if (
                (style.position === 'absolute' || style.position === 'fixed') &&
                (style.clip === 'rect(0px, 0px, 0px, 0px)' ||
                    style.clipPath === 'inset(50%)' ||
                    (parseFloat(style.width) <= 2 && parseFloat(style.height) <= 2))
            ) {
                return true;
            }

            curr = curr.parentElement;
        }
        return false;
    }

    // /**
    //  * Live DOM element se visible text nikalta hai (duplicate screen-reader spans ko hata kar)
    //  */
    // function getLiveVisibleText(el, preserveNewlines = false) {
    //     if (!el) return '';
    //     const parts = [];
    //     let lastTop = null;
    //     let lastAddedText = '';
    //     const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    //     let node;

    //     while ((node = walker.nextNode())) {
    //         const val = node.nodeValue ? node.nodeValue.trim() : '';
    //         if (!val) continue;

    //         const parent = node.parentElement;
    //         if (!parent) continue;

    //         if (
    //             parent.closest(
    //                 'svg, style, script, noscript, video, audio, button, .linkedin-comment-generator-ui, .linkedin-comment-generator-container, .linkedin-comment-generator-button, .visually-hidden, .a11y-text, .sr-only'
    //             )
    //         ) {
    //             continue;
    //         }

    //         const pr = parent.getBoundingClientRect();
    //         // Sirf 1x1px screen-reader box (jiska width aur height dono <= 2px ho) ko skip karein
    //         if (pr.width <= 2 && pr.height <= 2) continue;

    //         if (isHiddenOrScreenReaderOnly(parent, el)) continue;

    //         // Consecutive duplicate text node (agar visually-hidden unclipped ho) ko prevent karein
    //         if (val === lastAddedText && val.length > 15) continue;

    //         if (preserveNewlines && lastTop !== null && Math.abs(pr.top - lastTop) > 8) {
    //             parts.push('\n');
    //         }
    //         parts.push(val);
    //         lastAddedText = val;
    //         lastTop = pr.top;
    //     }

    //     if (preserveNewlines) {
    //         return parts
    //             .join(' ')
    //             .replace(/ *\n */g, '\n')
    //             .replace(/[ \t]+/g, ' ')
    //             .trim();
    //     }
    //     return parts.join(' ').replace(/\s+/g, ' ').trim();
    // }

    // /**
    //  * Action bar button ke andar ka visible text nikalta hai
    //  */
    // function getButtonVisibleText(btn) {
    //     if (!btn) return '';
    //     let text = '';
    //     const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT, null, false);
    //     let node;
    //     while ((node = walker.nextNode())) {
    //         const parent = node.parentElement;
    //         if (!parent) continue;
    //         if (parent.closest('svg, style, script, .visually-hidden, .a11y-text, .sr-only')) continue;
    //         const pr = parent.getBoundingClientRect();
    //         if (pr.width <= 2 && pr.height <= 2) continue;
    //         if (isHiddenOrScreenReaderOnly(parent, btn)) continue;
    //         text += node.nodeValue + ' ';
    //     }
    //     return text.replace(/\s+/g, ' ').trim();
    // }

    // /**
    //  * LinkedIn ke sabhi sections (Home Feed, Personal Profile, Company Page) me Social Action Bars dhoondhta hai
    //  */
    // function findAllActionBars() {
    //     const actionBars = [];

    //     // 1. Legacy selectors check
    //     const legacySelectors = [
    //         '.feed-shared-social-action-bar',
    //         '.feed-shared-social-actions',
    //         '.social-details-social-actions',
    //         '.update-v2-social-actions',
    //         '[data-view-name="feed-action-bar"]'
    //     ];
    //     document.querySelectorAll(legacySelectors.join(', ')).forEach(bar => {
    //         if (bar.offsetParent !== null && !isInsideVideoPlayer(bar)) {
    //             actionBars.push(bar);
    //         }
    //     });

    //     // 2. Universal Structural Detection (2026 LinkedIn Layout)
    //     const candidates = document.querySelectorAll('div, ul, section');
    //     const excludedTextRegex = /follow|connect|message|write article|photo|video|event|audio|documents|reactions|jobs|network|notifications/i;
    //     const validBtnTextRegex = /^(\d[\d,.]*[KMBkmb]?|like|comment|repost|send|share|react|support|love|insightful|celebrate|funny)?$/i;

    //     for (const container of candidates) {
    //         if (container.offsetParent === null) continue;
    //         if (
    //             container.closest(
    //                 'header, nav, #global-nav, aside, .linkedin-comment-generator-ui, .msg-overlay-list-bubble, .msg-overlay-container, .comments-comment-item, .comments-comments-list'
    //             )
    //         ) {
    //             continue;
    //         }

    //         const rect = container.getBoundingClientRect();
    //         if (rect.width < 100 || rect.width > 880 || rect.height < 20 || rect.height > 82) continue;
    //         if (isInsideVideoPlayer(container)) continue;

    //         const buttons = Array.from(container.querySelectorAll('button, [role="button"]')).filter(btn => {
    //             if (btn.classList.contains('linkedin-comment-generator-button')) return false;
    //             if (btn.closest('.linkedin-comment-generator-ui, .linkedin-comment-generator-container')) return false;
    //             if (isInsideVideoPlayer(btn)) return false;
    //             const bRect = btn.getBoundingClientRect();
    //             return bRect.width >= 12 && bRect.height >= 12 && bRect.height <= 58 && btn.querySelector('svg');
    //         });

    //         if (buttons.length < 3 || buttons.length > 12) continue;

    //         let bestRowButtons = [];
    //         for (const pivot of buttons) {
    //             const pivotMidY = pivot.getBoundingClientRect().top + pivot.getBoundingClientRect().height / 2;
    //             const row = buttons.filter(b => {
    //                 const bMidY = b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2;
    //                 return Math.abs(bMidY - pivotMidY) < 16;
    //             });
    //             if (row.length > bestRowButtons.length) {
    //                 bestRowButtons = row;
    //             }
    //         }

    //         if (bestRowButtons.length < 3) continue;

    //         let isSocialRow = true;
    //         let validCount = 0;

    //         for (const btn of bestRowButtons) {
    //             const txt = getButtonVisibleText(btn);
    //             const aria = (btn.getAttribute('aria-label') || '').toLowerCase();

    //             if (
    //                 /\b\d+:\d{2}\b/.test(txt) ||
    //                 /\b(0\.5|0\.75|1|1\.25|1\.5|2)x\b/i.test(txt) ||
    //                 /play|pause|mute|unmute|fullscreen/i.test(aria)
    //             ) {
    //                 isSocialRow = false;
    //                 break;
    //             }

    //             if (excludedTextRegex.test(txt) || txt.length > 18) {
    //                 isSocialRow = false;
    //                 break;
    //             }

    //             if (validBtnTextRegex.test(txt) || /like|react|comment|repost|send|share/i.test(aria)) {
    //                 validCount++;
    //             }
    //         }

    //         if (isSocialRow && validCount >= 3) {
    //             actionBars.push(container);
    //         }
    //     }

    //     // Deduplicate: Ek post ke action bar ke liye sirf 1 container rakhein
    //     const uniqueBars = [];
    //     for (const bar of actionBars) {
    //         const barRect = bar.getBoundingClientRect();
    //         const existingIndex = uniqueBars.findIndex(u => {
    //             if (u.contains(bar) || bar.contains(u)) return true;
    //             const uRect = u.getBoundingClientRect();
    //             return Math.abs(uRect.top - barRect.top) < 65 && Math.abs(uRect.left - barRect.left) < 250;
    //         });

    //         if (existingIndex === -1) {
    //             uniqueBars.push(bar);
    //         } else {
    //             const existing = uniqueBars[existingIndex];
    //             const exRect = existing.getBoundingClientRect();
    //             if (barRect.width > exRect.width && barRect.height <= 75) {
    //                 uniqueBars[existingIndex] = bar;
    //             }
    //         }
    //     }

    //     return uniqueBars;
    // }

    












    // /**
    //  * Action bar se upar walk karke POORA Single Post Card nikalta hai
    //  */
    // function getPostFromActionBar(actionBar) {
    //     const barRect = actionBar.getBoundingClientRect();

    //     const legacyPost = actionBar.closest(
    //         '.feed-shared-update-v2, .occludable-update, li.profile-creator-shared-feed-update__container, [data-urn^="urn:li:activity:"], [data-urn^="urn:li:ugcPost:"], [data-urn^="urn:li:share:"], [data-id^="urn:li:activity:"], [data-view-name="feed-full-update"], [data-view-name="profile-activity-card"]'
    //     );
    //     if (legacyPost && legacyPost.getBoundingClientRect().top < barRect.top - 60) {
    //         return legacyPost;
    //     }

    //     let curr = actionBar.parentElement;
    //     let bestCandidate = actionBar.parentElement;

    //     while (curr && curr !== document.body && curr.tagName !== 'MAIN') {
    //         const role = curr.getAttribute('role') || '';
    //         if (role === 'main' || role === 'feed') {
    //             return bestCandidate;
    //         }

    //         const rect = curr.getBoundingClientRect();
    //         // Agar container actionBar se 140px se zyada chauda hai, toh vo multi-column page wrapper hai
    //         if (barRect.width > 100 && rect.width > barRect.width + 140) {
    //             return bestCandidate;
    //         }

    //         // Jaise hi curr ke andar kisi DUSRI post ka Generate Comment container ya button mile, ruk jayein
    //         const genContainers = curr.querySelectorAll('.linkedin-comment-generator-container, .linkedin-comment-generator-button');
    //         for (const el of genContainers) {
    //             if (!actionBar.contains(el)) {
    //                 return bestCandidate;
    //             }
    //         }

    //         bestCandidate = curr;
    //         curr = curr.parentElement;
    //     }

    //     return bestCandidate;
    // }

    // function getAllPostsWithActionBars() {
    //     const allBars = findAllActionBars();
    //     const results = [];
    //     for (const bar of allBars) {
    //         const post = getPostFromActionBar(bar);
    //         if (post) {
    //             results.push({ post, actionBar: bar });
    //         }
    //     }
    //     return results;
    // }

    // /**
    //  * Current post ke upar wali post ki bottom boundary nikalta hai
    //  * Taaki upar wali post (jaise LeetCode post) ka text kabhi pick na ho
    //  */
    // function getPostTopBoundary(post, actionBar) {
    //     const postRect = post.getBoundingClientRect();
    //     const barTop = actionBar ? actionBar.getBoundingClientRect().top : postRect.bottom;
    //     let minTopBound = postRect.top - 10;

    //     const allMarkers = document.querySelectorAll(
    //         '.linkedin-comment-generator-container, .linkedin-comment-generator-button, .linkedin-comment-generator-ui'
    //     );
    //     for (const el of allMarkers) {
    //         if (actionBar && actionBar.contains(el)) continue;
    //         if (el === activeCommentUI) continue;
    //         if (el.classList.contains('linkedin-comment-generator-ui') && el._triggerButton && actionBar && actionBar.contains(el._triggerButton)) {
    //             continue;
    //         }

    //         let r = el.getBoundingClientRect();
    //         if (r.width === 0 && r.height === 0 && el.parentElement) {
    //             r = el.parentElement.getBoundingClientRect();
    //         }
    //         if (r.width === 0 && r.height === 0) continue;

    //         // Upar wali post ke button/UI ke theek niche boundary set karein
    //         if (r.bottom < barTop - 50 && r.bottom > minTopBound) {
    //             minTopBound = r.bottom + 10;
    //         }
    //     }
    //     return minTopBound;
    // }

    // /**
    //  * Post ke andar "... more" button ko auto-click karke pura caption kholta hai
    //  */
    // async function expandSeeMoreIfNeeded(post, actionBar, minTopBound) {
    //     try {
    //         const barTop = actionBar ? actionBar.getBoundingClientRect().top : post.getBoundingClientRect().bottom;
    //         const clickables = post.querySelectorAll('button, [role="button"], span, a');
    //         for (const el of clickables) {
    //             if (el.offsetParent === null) continue;
    //             if (actionBar && actionBar.contains(el)) continue;
    //             const r = el.getBoundingClientRect();
    //             if (r.top < minTopBound || r.bottom > barTop + 5 || r.width > 120 || r.height > 40) continue;
    //             const txt = (typeof el.innerText === 'string' ? el.innerText : '').trim();
    //             if (/^(\u2026|\.\.\.)?\s*(see\s+)?more$/i.test(txt)) {
    //                 el.click();
    //                 await new Promise(resolve => setTimeout(resolve, 250));
    //                 break;
    //             }
    //         }
    //     } catch (e) {
    //         debug.log('Could not expand see more', e);
    //     }
    // }

    // /**
    //  * Sirf current post (minTopBound aur actionBar ke beech) ka asli Caption extract karta hai
    //  */
    // function extractPostContent(post, actionBar = null) {
    //     if (!post) return 'LinkedIn post';

    //     const postRect = post.getBoundingClientRect();
    //     const barRect = actionBar ? actionBar.getBoundingClientRect() : postRect;
    //     const barTop = actionBar ? barRect.top : postRect.bottom;
    //     const cardLeft = actionBar ? barRect.left : postRect.left;
    //     const minTopBound = getPostTopBoundary(post, actionBar);
    //     const effectivePostTop = Math.max(postRect.top, minTopBound);

    //     const noiseRegex = new RegExp(
    //         [
    //             '^view .+ profile$',
    //             '^(followed by|liked by|reposted by)\\b',
    //             '^.+\\s+(likes this|commented|commented on this|reposted this|celebrates this|supports this|loves this|finds this insightful)$',
    //             '^(\\+?\\s*follow|following|connect|message|view my newsletter|view my services|visit my website|promoted|sponsored|\u2026\\s*more|\\.\\.\\.\\s*more|see more|more)$',
    //             '^[\u2022\u00b7]?\\s*(1st|2nd|3rd\\+|following)\\s*$',
    //             '^(\\d+\\s*(s|m|h|d|w|mo|yr|min|hr)s?|just now|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\s+\\d{1,2})(\\s*[\u2022\u00b7].*)?$',
    //             '^\\d+:\\d{2}(\\s*\\/\\s*\\d+:\\d{2})?$',
    //             '^(0\\.5|0\\.75|1|1\\.25|1\\.5|2)x$',
    //             '^\\d[\\d,.]*[KMBkmb]?\\s*(comments?|reposts?|reactions?|views?|followers?)?$',
    //             '^\\d+\\s+pages?$'
    //         ].join('|'),
    //         'i'
    //     );

    //     // STAGE 1: Direct LinkedIn Commentary Selectors (Strictly current post bounds ke andar)
    //     const commentarySelectors = [
    //         '[data-view-name="feed-commentary"]',
    //         '[data-test-id="main-feed-activity-card__commentary"]',
    //         '.attributed-text-segment-list__container',
    //         '.update-components-text',
    //         '.feed-shared-update-v2__description-wrapper',
    //         '.feed-shared-inline-show-more-text',
    //         '.feed-shared-text__text-view',
    //         '.feed-shared-update-v2__commentary',
    //         '.update-components-update-v2__commentary'
    //     ];

    //     for (const selector of commentarySelectors) {
    //         const matches = Array.from(post.querySelectorAll(selector)).filter(el => {
    //             if (el.closest('.comments-comments-list, .linkedin-comment-generator-ui, .update-components-actor, .update-components-header')) {
    //                 return false;
    //             }
    //             const r = el.getBoundingClientRect();
    //             return r.top >= minTopBound - 12 && r.bottom <= barTop + 12 && r.height > 10;
    //         });
    //         if (matches.length > 0) {
    //             const targetEl = matches[matches.length - 1];
    //             const txt = getLiveVisibleText(targetEl, true)
    //                 .replace(/(\u2026|\.\.\.)?\s*(see\s+)?more$/i, '')
    //                 .trim();
    //             if (txt.length >= 8) return txt;
    //         }
    //     }

    //     // STAGE 2: Author Avatar & Header Geometry (Author Name, Headline aur Timestamp ko skip karne ke liye)
    //     let authorAvatar = null;
    //     const candidateImgs = Array.from(post.querySelectorAll('img')).filter(img => {
    //         if (actionBar && actionBar.contains(img)) return false;
    //         const ir = img.getBoundingClientRect();
    //         return (
    //             ir.top >= effectivePostTop - 12 &&
    //             ir.top <= effectivePostTop + 135 &&
    //             ir.bottom < barTop - 35 &&
    //             ir.left >= cardLeft - 25 &&
    //             ir.left <= cardLeft + 95 &&
    //             ir.width >= 28 &&
    //             ir.width <= 80 &&
    //             ir.height >= 28 &&
    //             ir.height <= 80
    //         );
    //     });

    //     if (candidateImgs.length > 0) {
    //         candidateImgs.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    //         authorAvatar = candidateImgs[0];
    //     }

    //     const avRect = authorAvatar ? authorAvatar.getBoundingClientRect() : null;
    //     const headerTop = avRect ? avRect.top : effectivePostTop;
    //     const avatarBottom = avRect ? avRect.bottom : effectivePostTop + 55;
    //     const avatarRight = avRect ? avRect.right : cardLeft + 52;
    //     let headerBottom = avatarBottom + 12;

    //     if (avRect) {
    //         const headerEls = post.querySelectorAll('span, div, a, p, time');
    //         for (const el of headerEls) {
    //             if (el.children.length > 4) continue;
    //             const r = el.getBoundingClientRect();
    //             if (
    //                 r.left >= avatarRight - 10 &&
    //                 r.top >= headerTop - 10 &&
    //                 r.top <= avatarBottom + 16 &&
    //                 r.height > 8 &&
    //                 r.height <= 85 &&
    //                 r.bottom < barTop - 25
    //             ) {
    //                 headerBottom = Math.max(headerBottom, Math.min(r.bottom, avatarBottom + 38));
    //             }
    //         }
    //     }

    //     // STAGE 3: Line-by-Line Visible Text Reconstruction (Strictly minTopBound aur barTop ke beech)
    //     const lineBuckets = [];
    //     const walker = document.createTreeWalker(post, NodeFilter.SHOW_TEXT, null, false);
    //     let textNode;
    //     let lastNodeText = '';

    //     while ((textNode = walker.nextNode())) {
    //         const rawVal = textNode.nodeValue ? textNode.nodeValue.trim() : '';
    //         if (!rawVal) continue;

    //         const parent = textNode.parentElement;
    //         if (!parent) continue;

    //         if (
    //             parent.closest(
    //                 'button, svg, style, script, noscript, video, audio, .comments-comments-list, .update-components-actor, .update-components-header, .linkedin-comment-generator-ui, .linkedin-comment-generator-container, .visually-hidden, .a11y-text, .sr-only'
    //             )
    //         ) {
    //             continue;
    //         }
    //         if (actionBar && actionBar.contains(parent)) continue;
    //         if (isInsideVideoPlayer(parent)) continue;

    //         const pr = parent.getBoundingClientRect();
    //         if (pr.width <= 2 && pr.height <= 2) continue;
    //         if (isHiddenOrScreenReaderOnly(parent, post)) continue;

    //         // Strictly current post ki vertical boundary check karein (upar wali post ko block karein)
    //         if (pr.top < minTopBound - 5 || pr.bottom <= headerTop + 2 || pr.bottom > barTop + 8) continue;

    //         // Author Header box (Avatar ke right side me Author Name, Headline, 3h timestamp) ko skip karein
    //         // Note: Post ka asli caption cardLeft se shuru hota hai, isliye left-aligned text kabhi skip nahi hoga
    //         if (pr.left >= avatarRight - 10 && pr.top < headerBottom + 4) continue;

    //         const cleanedVal = rawVal.replace(/(\u2026|\.\.\.)?\s*(see\s+)?more$/i, '').trim();
    //         if (!cleanedVal || noiseRegex.test(cleanedVal)) continue;

    //         if (cleanedVal === lastNodeText && cleanedVal.length > 15) continue;
    //         lastNodeText = cleanedVal;

    //         let bucket = lineBuckets.find(b => Math.abs(b.top - pr.top) < 8);
    //         if (!bucket) {
    //             bucket = { top: pr.top, parts: [] };
    //             lineBuckets.push(bucket);
    //         }
    //         bucket.parts.push({ left: pr.left, text: cleanedVal });
    //     }

    //     if (lineBuckets.length > 0) {
    //         lineBuckets.sort((a, b) => a.top - b.top);
    //         const finalLines = lineBuckets
    //             .map(b => {
    //                 b.parts.sort((x, y) => x.left - y.left);
    //                 return b.parts.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();
    //             })
    //             .filter(line => line.length > 0 && !noiseRegex.test(line));

    //         const dedupedLines = finalLines.filter((line, idx) => idx === 0 || line !== finalLines[idx - 1]);
    //         const joinedResult = dedupedLines.join('\n').trim();
    //         if (joinedResult.length >= 4) {
    //             return joinedResult;
    //         }
    //     }

    //     return 'LinkedIn post';
    // }














    

    /**
     * Element ya Text node ka asli screen bounding rect nikalta hai
     * (LinkedIn ke display: contents wrappers aur scrolled posts par 100% accurate kaam karta hai)
     */
    function getRealRect(node) {
        if (!node) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
        if (node.nodeType === Node.ELEMENT_NODE) {
            const r = node.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) {
                return r;
            }
        }
        try {
            const range = document.createRange();
            range.selectNodeContents(node);
            return range.getBoundingClientRect();
        } catch (e) {
            return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
        }
    }

    /**
     * Live DOM element se visible text nikalta hai (display: contents spans ko skip kiye bina)
     */
    function getLiveVisibleText(el, preserveNewlines = false) {
        if (!el) return '';
        const parts = [];
        let lastTop = null;
        let lastAddedText = '';
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        let node;

        while ((node = walker.nextNode())) {
            const val = node.nodeValue ? node.nodeValue.trim() : '';
            if (!val) continue;
            const parent = node.parentElement;
            if (!parent) continue;

            if (
                parent.closest(
                    'svg, style, script, noscript, video, audio, button, .linkedin-comment-generator-ui, .linkedin-comment-generator-container, .linkedin-comment-generator-button, .visually-hidden, .a11y-text, .sr-only'
                )
            ) {
                continue;
            }

            if (isHiddenOrScreenReaderOnly(parent, el)) continue;

            // Text node ka real rect Range API se nikalein (taaki display: contents par 0x0 na aaye)
            const tr = getRealRect(node);
            if (tr.width <= 1 && tr.height <= 1) continue;

            if (val === lastAddedText && val.length > 15) continue;

            if (preserveNewlines && lastTop !== null && Math.abs(tr.top - lastTop) > 8) {
                parts.push('\n');
            }
            parts.push(val);
            lastAddedText = val;
            lastTop = tr.top;
        }

        if (preserveNewlines) {
            return parts
                .join(' ')
                .replace(/ *\n */g, '\n')
                .replace(/[ \t]+/g, ' ')
                .trim();
        }
        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    /**
     * Action bar button ke andar ka visible text nikalta hai
     */
    function getButtonVisibleText(btn) {
        if (!btn) return '';
        let text = '';
        const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (!parent) continue;
            if (parent.closest('svg, style, script, .visually-hidden, .a11y-text, .sr-only')) continue;
            if (isHiddenOrScreenReaderOnly(parent, btn)) continue;
            const tr = getRealRect(node);
            if (tr.width <= 1 && tr.height <= 1) continue;
            text += node.nodeValue + ' ';
        }
        return text.replace(/\s+/g, ' ').trim();
    }

    /**
     * LinkedIn ke sabhi sections (Home Feed, Personal Profile, Company Page) me Social Action Bars dhoondhta hai
     */
    function findAllActionBars() {
        const actionBars = [];

        const legacySelectors = [
            '.feed-shared-social-action-bar',
            '.feed-shared-social-actions',
            '.social-details-social-actions',
            '.update-v2-social-actions',
            '[data-view-name="feed-action-bar"]'
        ];
        document.querySelectorAll(legacySelectors.join(', ')).forEach(bar => {
            if (bar.offsetParent !== null && !isInsideVideoPlayer(bar)) {
                actionBars.push(bar);
            }
        });

        const candidates = document.querySelectorAll('div, ul, section');
        const excludedTextRegex = /follow|connect|message|write article|photo|video|event|audio|documents|reactions|jobs|network|notifications/i;
        const validBtnTextRegex = /^(\d[\d,.]*[KMBkmb]?|like|comment|repost|send|share|react|support|love|insightful|celebrate|funny)?$/i;

        for (const container of candidates) {
            if (container.offsetParent === null) continue;
            if (
                container.closest(
                    'header, nav, #global-nav, aside, .linkedin-comment-generator-ui, .msg-overlay-list-bubble, .msg-overlay-container, .comments-comment-item, .comments-comments-list'
                )
            ) {
                continue;
            }

            const rect = container.getBoundingClientRect();
            if (rect.width < 100 || rect.width > 880 || rect.height < 20 || rect.height > 82) continue;
            if (isInsideVideoPlayer(container)) continue;

            const buttons = Array.from(container.querySelectorAll('button, [role="button"]')).filter(btn => {
                if (btn.classList.contains('linkedin-comment-generator-button')) return false;
                if (btn.closest('.linkedin-comment-generator-ui, .linkedin-comment-generator-container')) return false;
                if (isInsideVideoPlayer(btn)) return false;
                const bRect = btn.getBoundingClientRect();
                return bRect.width >= 12 && bRect.height >= 12 && bRect.height <= 58 && btn.querySelector('svg');
            });

            if (buttons.length < 3 || buttons.length > 12) continue;

            let bestRowButtons = [];
            for (const pivot of buttons) {
                const pivotMidY = pivot.getBoundingClientRect().top + pivot.getBoundingClientRect().height / 2;
                const row = buttons.filter(b => {
                    const bMidY = b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2;
                    return Math.abs(bMidY - pivotMidY) < 16;
                });
                if (row.length > bestRowButtons.length) {
                    bestRowButtons = row;
                }
            }

            if (bestRowButtons.length < 3) continue;

            let isSocialRow = true;
            let validCount = 0;

            for (const btn of bestRowButtons) {
                const txt = getButtonVisibleText(btn);
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();

                if (
                    /\b\d+:\d{2}\b/.test(txt) ||
                    /\b(0\.5|0\.75|1|1\.25|1\.5|2)x\b/i.test(txt) ||
                    /play|pause|mute|unmute|fullscreen/i.test(aria)
                ) {
                    isSocialRow = false;
                    break;
                }
                if (excludedTextRegex.test(txt) || txt.length > 18) {
                    isSocialRow = false;
                    break;
                }
                if (validBtnTextRegex.test(txt) || /like|react|comment|repost|send|share/i.test(aria)) {
                    validCount++;
                }
            }

            if (isSocialRow && validCount >= 3) {
                actionBars.push(container);
            }
        }

        const uniqueBars = [];
        for (const bar of actionBars) {
            const barRect = bar.getBoundingClientRect();
            const existingIndex = uniqueBars.findIndex(u => {
                if (u.contains(bar) || bar.contains(u)) return true;
                const uRect = u.getBoundingClientRect();
                return Math.abs(uRect.top - barRect.top) < 65 && Math.abs(uRect.left - barRect.left) < 250;
            });

            if (existingIndex === -1) {
                uniqueBars.push(bar);
            } else {
                const existing = uniqueBars[existingIndex];
                const exRect = existing.getBoundingClientRect();
                if (barRect.width > exRect.width && barRect.height <= 75) {
                    uniqueBars[existingIndex] = bar;
                }
            }
        }

        return uniqueBars;
    }

    /**
     * Action bar se upar walk karke POORA Single Post Card nikalta hai
     */
    function getPostFromActionBar(actionBar) {
        const barRect = getRealRect(actionBar);

        const legacyPost = actionBar.closest(
            '.feed-shared-update-v2, .occludable-update, li.profile-creator-shared-feed-update__container, [data-urn^="urn:li:activity:"], [data-urn^="urn:li:ugcPost:"], [data-urn^="urn:li:share:"], [data-id^="urn:li:activity:"], [data-view-name="feed-full-update"], [data-view-name="profile-activity-card"]'
        );
        if (legacyPost && getRealRect(legacyPost).top < barRect.top - 60) {
            return legacyPost;
        }

        let curr = actionBar.parentElement;
        let bestCandidate = actionBar.parentElement;

        while (curr && curr !== document.body && curr.tagName !== 'MAIN') {
            const role = curr.getAttribute('role') || '';
            if (role === 'main' || role === 'feed') {
                return bestCandidate;
            }

            const rect = getRealRect(curr);
            if (rect.width > 920) {
                return bestCandidate;
            }

            const genContainers = curr.querySelectorAll('.linkedin-comment-generator-container, .linkedin-comment-generator-button');
            for (const el of genContainers) {
                if (!actionBar.contains(el)) {
                    return bestCandidate;
                }
            }

            bestCandidate = curr;
            curr = curr.parentElement;
        }

        return bestCandidate;
    }

    function getAllPostsWithActionBars() {
        const allBars = findAllActionBars();
        const results = [];
        for (const bar of allBars) {
            const post = getPostFromActionBar(bar);
            if (post) {
                results.push({ post, actionBar: bar });
            }
        }
        return results;
    }

    /**
     * Current post ke upar wali post ki bottom boundary nikalta hai (display: contents safe)
     */
    function getPostTopBoundary(post, actionBar) {
        const postRect = getRealRect(post);
        const barTop = actionBar ? getRealRect(actionBar).top : postRect.bottom;
        let minTopBound = postRect.top - 12;

        const allMarkers = document.querySelectorAll(
            '.linkedin-comment-generator-container, .linkedin-comment-generator-button, .linkedin-comment-generator-ui'
        );
        for (const el of allMarkers) {
            if (actionBar && actionBar.contains(el)) continue;
            if (el === activeCommentUI) continue;
            if (el.classList.contains('linkedin-comment-generator-ui') && el._triggerButton && actionBar && actionBar.contains(el._triggerButton)) {
                continue;
            }

            const r = getRealRect(el);
            if (r.width === 0 && r.height === 0) continue;

            if (r.bottom < barTop - 50 && r.bottom > minTopBound) {
                minTopBound = r.bottom + 10;
            }
        }
        return minTopBound;
    }

    /**
     * Post ke andar "... more" button ko auto-click karke pura caption kholta hai
     */
    async function expandSeeMoreIfNeeded(post, actionBar, minTopBound) {
        try {
            const barTop = actionBar ? getRealRect(actionBar).top : getRealRect(post).bottom;
            const clickables = post.querySelectorAll('button, [role="button"], span, a');
            for (const el of clickables) {
                if (actionBar && actionBar.contains(el)) continue;
                if (isHiddenOrScreenReaderOnly(el, post)) continue;
                const r = getRealRect(el);
                if (r.width === 0 || r.height === 0) continue;
                if (r.top < minTopBound || r.bottom > barTop + 5 || r.width > 130 || r.height > 42) continue;
                const txt = (typeof el.innerText === 'string' ? el.innerText : el.textContent || '').trim();
                if (/^(\u2026|\.\.\.)?\s*(see\s+)?more$/i.test(txt)) {
                    el.click();
                    await new Promise(resolve => setTimeout(resolve, 250));
                    break;
                }
            }
        } catch (e) {
            debug.log('Could not expand see more', e);
        }
    }

    /**
     * Post me se activity header ("Jayesh Thakare commented") aur author header ko chhod kar
     * SIRF current post ka pura Caption extract karta hai
     */
    function extractPostContent(post, actionBar = null) {
        if (!post) return 'LinkedIn post';

        const postRect = getRealRect(post);
        const barRect = actionBar ? getRealRect(actionBar) : postRect;
        const barTop = actionBar ? barRect.top : postRect.bottom;
        const cardLeft = postRect.width > 50 ? postRect.left : barRect.left;
        const minTopBound = getPostTopBoundary(post, actionBar);
        const effectivePostTop = Math.max(postRect.top, minTopBound);

        const noiseRegex = new RegExp(
            [
                '^view .+ profile$',
                '^(followed by|liked by|reposted by)\\b',
                '^.+\\s+(likes this|liked this|commented|commented on this|reposted this|shared this|celebrates this|supports this|loves this|finds this insightful)$',
                '^(\\+?\\s*follow|following|connect|message|view my newsletter|view my services|visit my website|promoted|sponsored|\u2026\\s*more|\\.\\.\\.\\s*more|see more|more)$',
                '^[\u2022\u00b7]?\\s*(1st|2nd|3rd\\+|following)\\s*$',
                '^(\\d+\\s*(s|m|h|d|w|mo|yr|min|hr)s?|just now|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\s+\\d{1,2})(\\s*[\u2022\u00b7].*)?$',
                '^\\d+:\\d{2}(\\s*\\/\\s*\\d+:\\d{2})?$',
                '^(0\\.5|0\\.75|1|1\\.25|1\\.5|2)x$',
                '^\\d[\\d,.]*[KMBkmb]?\\s*(comments?|reposts?|reactions?|views?|followers?)?$',
                '^\\d+\\s+pages?$'
            ].join('|'),
            'i'
        );

        // STAGE 1: Direct LinkedIn Commentary Selectors
        const commentarySelectors = [
            '[data-view-name="feed-commentary"]',
            '[data-test-id="main-feed-activity-card__commentary"]',
            '.attributed-text-segment-list__container',
            '.update-components-text',
            '.feed-shared-update-v2__description-wrapper',
            '.feed-shared-inline-show-more-text',
            '.feed-shared-text__text-view',
            '.feed-shared-update-v2__commentary',
            '.update-components-update-v2__commentary'
        ];

        for (const selector of commentarySelectors) {
            const matches = Array.from(post.querySelectorAll(selector)).filter(el => {
                if (el.closest('.comments-comments-list, .comments-comment-item, .linkedin-comment-generator-ui, .update-components-actor, .update-components-header')) {
                    return false;
                }
                const r = getRealRect(el);
                return r.top >= minTopBound - 15 && r.bottom <= barTop + 15 && r.height > 10;
            });
            if (matches.length > 0) {
                let bestText = '';
                for (const m of matches) {
                    const txt = getLiveVisibleText(m, true)
                        .replace(/(\u2026|\.\.\.)?\s*(see\s+)?more$/i, '')
                        .trim();
                    if (txt.length > bestText.length) {
                        bestText = txt;
                    }
                }
                if (bestText.length >= 8) return bestText;
            }
        }

        // STAGE 2: Author Avatar & Header Geometry
        // Agar upar "Jayesh Thakare commented" (chhota avatar) aur niche main Author ("Nilam Awale", bada avatar) dono hon,
        // toh main Author avatar ko pick karein taaki dono headers skip ho jayein
        let authorAvatar = null;
        const candidateImgs = Array.from(post.querySelectorAll('img')).filter(img => {
            if (actionBar && actionBar.contains(img)) return false;
            const ir = img.getBoundingClientRect();
            return (
                ir.top >= effectivePostTop - 15 &&
                ir.top <= effectivePostTop + 165 &&
                ir.bottom < barTop - 35 &&
                ir.left >= cardLeft - 30 &&
                ir.left <= cardLeft + 105 &&
                ir.width >= 24 &&
                ir.width <= 80 &&
                ir.height >= 24 &&
                ir.height <= 80
            );
        });

        if (candidateImgs.length > 0) {
            // Main author avatars (>= 38px) ko chhote activity avatars (24-32px) par priority dein
            const mainAvatars = candidateImgs.filter(img => {
                const ir = img.getBoundingClientRect();
                return ir.width >= 38 && ir.height >= 38;
            });
            const pool = mainAvatars.length > 0 ? mainAvatars : candidateImgs;
            pool.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
            authorAvatar = pool[0];
        }

        const avRect = authorAvatar ? authorAvatar.getBoundingClientRect() : null;
        const headerTop = avRect ? avRect.top : effectivePostTop;
        const avatarBottom = avRect ? avRect.bottom : effectivePostTop + 55;
        const avatarRight = avRect ? avRect.right : cardLeft + 52;
        let headerBottom = avatarBottom + 12;

        if (avRect) {
            const headerEls = post.querySelectorAll('span, div, a, p, time');
            for (const el of headerEls) {
                if (el.children.length > 4) continue;
                const r = getRealRect(el);
                if (
                    r.left >= avatarRight - 10 &&
                    r.top >= headerTop - 10 &&
                    r.top <= avatarBottom + 18 &&
                    r.height > 8 &&
                    r.height <= 85 &&
                    r.bottom < barTop - 25
                ) {
                    headerBottom = Math.max(headerBottom, Math.min(r.bottom, avatarBottom + 40));
                }
            }
        }

        // STAGE 3: Line-by-Line Range-Based Reconstruction (display: contents aur multi-line spans par 100% accurate)
        const lineBuckets = [];
        const walker = document.createTreeWalker(post, NodeFilter.SHOW_TEXT, null, false);
        let textNode;
        let lastNodeText = '';

        while ((textNode = walker.nextNode())) {
            const rawVal = textNode.nodeValue ? textNode.nodeValue.trim() : '';
            if (!rawVal) continue;

            const parent = textNode.parentElement;
            if (!parent) continue;

            if (
                parent.closest(
                    'button, svg, style, script, noscript, video, audio, .comments-comments-list, .comments-comment-item, .update-components-actor, .update-components-header, .linkedin-comment-generator-ui, .linkedin-comment-generator-container, .visually-hidden, .a11y-text, .sr-only'
                )
            ) {
                continue;
            }
            if (actionBar && actionBar.contains(parent)) continue;
            if (isInsideVideoPlayer(parent)) continue;
            if (isHiddenOrScreenReaderOnly(parent, post)) continue;

            // Har textNode ka exact line position Range API se nikalein
            const tr = getRealRect(textNode);
            if (tr.width <= 1 && tr.height <= 1) continue;

            // Strictly current post ki vertical boundary check karein (headerTop ke upar wala "Jayesh Thakare commented" bhi skip hoga)
            if (tr.top < minTopBound - 5 || tr.bottom <= headerTop + 2 || tr.bottom > barTop + 8) continue;

            // Author Header box (Avatar ke right side me Author Name, Headline, Timestamp) ko skip karein
            if (tr.left >= avatarRight - 10 && tr.top < headerBottom + 4) continue;

            const cleanedVal = rawVal.replace(/(\u2026|\.\.\.)?\s*(see\s+)?more$/i, '').trim();
            if (!cleanedVal || noiseRegex.test(cleanedVal)) continue;

            if (cleanedVal === lastNodeText && cleanedVal.length > 15) continue;
            lastNodeText = cleanedVal;

            let bucket = lineBuckets.find(b => Math.abs(b.top - tr.top) < 8);
            if (!bucket) {
                bucket = { top: tr.top, parts: [] };
                lineBuckets.push(bucket);
            }
            bucket.parts.push({ left: tr.left, text: cleanedVal });
        }

        if (lineBuckets.length > 0) {
            lineBuckets.sort((a, b) => a.top - b.top);
            const finalLines = lineBuckets
                .map(b => {
                    b.parts.sort((x, y) => x.left - y.left);
                    return b.parts.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();
                })
                .filter(line => line.length > 0 && !noiseRegex.test(line));

            const dedupedLines = finalLines.filter((line, idx) => idx === 0 || line !== finalLines[idx - 1]);
            const joinedResult = dedupedLines.join('\n').trim();
            if (joinedResult.length >= 4) {
                return joinedResult;
            }
        }

        return 'LinkedIn post';
    }






















    async function getUserInfo() {
        try {
            const userInfo = { id: 'linkedin_user', email: 'unknown', name: 'unknown', profileUrl: null };
            const profileLink = document.querySelector('a[href*="/in/"]');
            if (profileLink && profileLink.href) {
                userInfo.profileUrl = profileLink.href;
                const match = profileLink.href.match(/\/in\/([^\/?#]+)/);
                if (match) userInfo.id = match[1];
            }
            return userInfo;
        } catch (e) {
            return { id: 'linkedin_user', email: 'unknown', name: 'unknown', profileUrl: null };
        }
    }

    async function generateCommentAPI(content, hint, tone, model) {
        if (!API_CONFIG.URL) {
            throw new Error('API endpoint not configured in code.');
        }

        const userInfo = await getUserInfo();
        const uniqueId = `${userInfo.id}_${Date.now()}`;

        const payload = {
            hint: hint || '',
            caption: content,
            tone: tone || 'professional',
            model: GPT_MODELS.getApiName(model || 'qwen2.5:7b'),
            unique_id: uniqueId,
            user_info: {
                id: userInfo.id || 'unknown',
                email: userInfo.email || 'unknown',
                name: userInfo.name || 'unknown',
                profile_url: userInfo.profileUrl || 'unknown'
            }
        };

        const bgResponse = await new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(
                    { action: 'callN8nApi', url: API_CONFIG.URL, payload },
                    response => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(response);
                        }
                    }
                );
            } catch (err) {
                reject(new Error('Extension was updated. Please press F5 to refresh this LinkedIn page once.'));
            }
        });

        if (!bgResponse || !bgResponse.success) {
            throw new Error(bgResponse?.error || 'Failed to connect to local n8n webhook');
        }

        const data = bgResponse.data;
        const comment = Array.isArray(data)
            ? data[0]?.comment || data[0]?.output || data[0]?.text || data[0]?.response
            : data?.comment || data?.output || data?.text || data?.response;

        if (!comment) {
            throw new Error('API response missing comment field');
        }

        return comment;
    }

    function createGenerateButton() {
        const button = document.createElement('button');
        button.type = 'button';
        button.innerHTML = `<span class="button-icon">\u2728</span> Generate Comment`;
        button.className = 'linkedin-comment-generator-button';
        button.style.cssText = `
            background-color: #0a66c2;
            color: #ffffff !important;
            border: none;
            border-radius: 999px;
            padding: 6px 14px;
            margin: 0 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            white-space: nowrap;
            flex-shrink: 0;
            box-shadow: 0 2px 6px rgba(10,102,194,0.3);
            transition: all 0.2s ease;
            z-index: 10;
        `;

        button.onmouseover = () => {
            button.style.backgroundColor = '#004182';
            button.style.transform = 'translateY(-1px)';
        };
        button.onmouseout = () => {
            button.style.backgroundColor = '#0a66c2';
            button.style.transform = 'translateY(0)';
        };

        return button;
    }

    function createCommentUI(actionBar, generateButton) {
        const container = document.createElement('div');
        container.className = 'linkedin-comment-generator-ui';
        container.style.cssText = `
            padding: 18px;
            background: #ffffff;
            color: #191919;
            border: 1px solid #d0d7de;
            border-radius: 12px;
            margin: 12px 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.2);
            position: relative;
            z-index: 100;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;

        const heading = document.createElement('h3');
        heading.textContent = 'Generate Comment';
        heading.style.cssText = `margin: 0 0 10px 0; font-size: 17px; color: #0a66c2; font-weight: 600;`;

        const captionPreview = document.createElement('div');
        captionPreview.style.cssText = `
            font-size: 12px; color: #374151; background: #f3f6f8; padding: 8px 10px;
            border-radius: 6px; margin-bottom: 12px; max-height: 75px; overflow-y: auto;
            border-left: 3px solid #0a66c2; line-height: 1.4; white-space: pre-wrap;
        `;
        captionPreview.textContent = 'Select a Tone below and click "Generate" to send post caption to n8n.';

        const toneLabel = document.createElement('label');
        toneLabel.textContent = 'Tone:';
        toneLabel.style.cssText = `display: block; margin-bottom: 4px; font-size: 13px; color: #444; font-weight: 600;`;

        const toneSelect = document.createElement('select');
        toneSelect.style.cssText = `
            width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px;
            margin-bottom: 12px; font-size: 14px; background: #fff; color: #191919; font-weight: 600;
            cursor: pointer;
        `;
        const tones = [
            { value: 'professional', label: 'Professional \uD83D\uDCBC' },
            { value: 'supportive', label: 'Supportive \uD83E\uDD1D' },
            { value: 'friendly', label: 'Friendly \uD83D\uDE0A' },
            { value: 'inquisitive', label: 'Inquisitive \u2753' },
            { value: 'cheerful', label: 'Cheerful \uD83C\uDF89' },
            { value: 'funny', label: 'Funny \uD83D\uDE02' }
        ];
        tones.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.value;
            opt.textContent = t.label;
            toneSelect.appendChild(opt);
        });

        const modelLabel = document.createElement('label');
        modelLabel.textContent = 'Model:';
        modelLabel.style.cssText = `display: block; margin-bottom: 4px; font-size: 13px; color: #444; font-weight: 600;`;

        const modelSelect = document.createElement('select');
        modelSelect.style.cssText = `
            width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px;
            margin-bottom: 12px; font-size: 14px; background: #fff; color: #191919; font-weight: 600;
            cursor: pointer;
        `;
        GPT_MODELS.MODELS.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.value;
            opt.textContent = m.label;
            modelSelect.appendChild(opt);
        });

        const commentBoxContainer = document.createElement('div');
        commentBoxContainer.style.cssText = `position: relative; width: 100%; margin-bottom: 10px;`;

        const commentBox = document.createElement('textarea');
        commentBox.readOnly = true;
        commentBox.placeholder = 'Select a tone above and click Generate...';
        commentBox.style.cssText = `
            width: 100%; min-height: 110px; padding: 12px; border: 1px solid #ccc;
            border-radius: 8px; font-size: 14px; line-height: 1.5; resize: vertical;
            box-sizing: border-box; background-color: #f9fafb; color: #191919;
        `;

        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.title = 'Copy comment to clipboard';
        copyButton.textContent = 'Copy';
        copyButton.style.cssText = `
            position: absolute; top: 8px; right: 8px; background: #e8f0fe;
            border: 1px solid #0a66c2; border-radius: 6px; padding: 4px 10px;
            cursor: pointer; color: #0a66c2; font-size: 12px; font-weight: 600;
        `;
        copyButton.addEventListener('click', () => {
            if (!commentBox.value || commentBox.value === 'Analyzing Post...') return;
            navigator.clipboard.writeText(commentBox.value).then(() => {
                copyButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyButton.textContent = 'Copy';
                }, 2000);
            });
        });

        commentBoxContainer.appendChild(commentBox);
        commentBoxContainer.appendChild(copyButton);

        const hintInput = document.createElement('input');
        hintInput.type = 'text';
        hintInput.placeholder = 'Add feedback or hint (optional)';
        hintInput.style.cssText = `
            width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 8px;
            margin-bottom: 12px; font-size: 14px; box-sizing: border-box; background: #fff; color: #191919;
        `;

        const regenerateBtn = document.createElement('button');
        regenerateBtn.type = 'button';
        regenerateBtn.className = 'lcg-regenerate-btn';
        regenerateBtn.textContent = 'Generate';
        regenerateBtn.style.cssText = `
            padding: 10px 20px; border: none; border-radius: 24px; background-color: #0a66c2;
            color: white; cursor: pointer; font-weight: 600; font-size: 14px; width: 100%;
        `;

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '\u2715';
        closeBtn.style.cssText = `
            position: absolute; top: 12px; right: 12px; border: none; background: transparent;
            color: #555; cursor: pointer; font-size: 18px; font-weight: bold;
        `;
        closeBtn.addEventListener('click', () => {
            container.remove();
            activeCommentUI = null;
            if (generateButton) generateButton.style.display = 'inline-flex';
        });

        // UI khulte hi post ka "... more" expand karke caption preview dikha dein (bina API call kiye)
        let cachedCaption = '';
        (async () => {
            const freshPost = getPostFromActionBar(actionBar);
            const minTopBound = getPostTopBoundary(freshPost, actionBar);
            await expandSeeMoreIfNeeded(freshPost, actionBar, minTopBound);
            cachedCaption = extractPostContent(freshPost, actionBar);
            captionPreview.textContent = `Detected Post Caption:\n${cachedCaption}`;
        })();

        // Jab user Tone select karne ke baad Generate button par click karega tabhi n8n ko request jayegi
        regenerateBtn.addEventListener('click', async () => {
            commentBox.value = 'Analyzing Post...';
            regenerateBtn.disabled = true;

            const freshPost = getPostFromActionBar(actionBar);
            const minTopBound = getPostTopBoundary(freshPost, actionBar);
            await expandSeeMoreIfNeeded(freshPost, actionBar, minTopBound);
            const latestExtracted = extractPostContent(freshPost, actionBar);
            const content =
                latestExtracted && latestExtracted !== 'LinkedIn post'
                    ? latestExtracted
                    : cachedCaption || 'LinkedIn post';

            cachedCaption = content;
            captionPreview.textContent = `Post Caption Sent to n8n:\n${content}`;

            try {
                const comment = await generateCommentAPI(
                    content,
                    hintInput.value.trim(),
                    toneSelect.value,
                    modelSelect.value
                );
                commentBox.value = comment;
            } catch (apiError) {
                commentBox.value = `Error: Could not generate comment. ${apiError.message}`;
            }
            regenerateBtn.disabled = false;
        });

        container.appendChild(closeBtn);
        container.appendChild(heading);
        container.appendChild(captionPreview);
        container.appendChild(toneLabel);
        container.appendChild(toneSelect);
        container.appendChild(modelLabel);
        container.appendChild(modelSelect);
        container.appendChild(commentBoxContainer);
        container.appendChild(hintInput);
        container.appendChild(regenerateBtn);

        return container;
    }

    /**
     * Har post ke social action bar me sirf 1 baar Generate Comment button lagata hai
     */
    function addButtonsToPosts() {
        try {
            const postsWithBars = getAllPostsWithActionBars();
            const existingButtons = Array.from(document.querySelectorAll('.linkedin-comment-generator-button'));

            postsWithBars.forEach(({ post, actionBar }) => {
                if (
                    actionBar.querySelector('.linkedin-comment-generator-button') ||
                    actionBar.parentElement?.querySelector('.linkedin-comment-generator-button')
                ) {
                    return;
                }

                const barRect = actionBar.getBoundingClientRect();
                const hasNearbyButton = existingButtons.some(btn => {
                    const bRect = btn.getBoundingClientRect();
                    return Math.abs(bRect.top - barRect.top) < 85 && Math.abs(bRect.left - barRect.left) < 650;
                });
                if (hasNearbyButton) return;

                const buttonContainer = document.createElement('div');
                buttonContainer.className = 'linkedin-comment-generator-container';
                buttonContainer.style.cssText = `
                    display: inline-flex;
                    align-items: center;
                    vertical-align: middle;
                    margin-left: 6px;
                `;

                const button = createGenerateButton();

                button.addEventListener('click', e => {
                    e.stopPropagation();
                    e.preventDefault();

                    if (activeCommentUI) {
                        const prevBtn = activeCommentUI._triggerButton;
                        if (prevBtn) prevBtn.style.display = 'inline-flex';
                        activeCommentUI.remove();
                        activeCommentUI = null;
                    }

                    button.style.display = 'none';
                    const commentUI = createCommentUI(actionBar, button);
                    commentUI._triggerButton = button;

                    if (actionBar.parentNode) {
                        actionBar.parentNode.insertBefore(commentUI, actionBar.nextSibling);
                    } else {
                        post.appendChild(commentUI);
                    }
                    activeCommentUI = commentUI;
                    // Auto-click hata diya gaya hai: ab user pehle Tone select karega aur phir Generate click karega
                });

                buttonContainer.appendChild(button);
                actionBar.appendChild(buttonContainer);
                existingButtons.push(button);
            });
        } catch (err) {
            debug.error('Error in addButtonsToPosts', err);
        }
    }

    function findCurrentPost() {
        const postsWithBars = getAllPostsWithActionBars();
        for (const item of postsWithBars) {
            const rect = item.post.getBoundingClientRect();
            if (rect.top < window.innerHeight * 0.75 && rect.bottom > 100) {
                return item;
            }
        }
        return postsWithBars[0] || null;
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        try {
            if (request.action === 'getSelectedPost') {
                const current = findCurrentPost();
                if (current) {
                    const freshPost = getPostFromActionBar(current.actionBar);
                    const minTopBound = getPostTopBoundary(freshPost, current.actionBar);
                    expandSeeMoreIfNeeded(freshPost, current.actionBar, minTopBound).then(() => {
                        const content = extractPostContent(freshPost, current.actionBar);
                        sendResponse({ success: true, content });
                    });
                    return true;
                } else {
                    sendResponse({ success: false, error: 'No post found' });
                }
            } else if (request.action === 'generateComment') {
                generateCommentAPI(
                    request.content,
                    request.hint,
                    request.tone || 'professional',
                    request.model || 'qwen2.5:7b'
                )
                    .then(comment => sendResponse({ success: true, comment }))
                    .catch(err => sendResponse({ success: false, error: err.message }));
                return true;
            }
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
        return true;
    });

    function initialize() {
        setTimeout(addButtonsToPosts, 600);
        window._lcgInterval = setInterval(addButtonsToPosts, 1800);

        const observer = new MutationObserver(() => {
            addButtonsToPosts();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window._lcgObserver = observer;
    }

    initialize();
})();