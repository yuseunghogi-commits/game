/*
 * DevTools Browser — 페이지에 Eruda(모바일 개발자 도구)를 붙이는 스크립트.
 *
 * 앱(DevTools.java)이 아래 ERUDA 표시 줄을 eruda.js 내용(이미 불러온 페이지에는 빈 문자열)으로 바꾸고,
 * 맨 끝의 MODE 표시를 아래 셋 중 하나로 바꿔 실행한다. 마지막 식의 값이 evaluateJavascript 결과가 된다.
 * (표시 문자열은 이 주석에 그대로 쓰지 않는다. 주석 안에서 바뀌면 eruda 코드가 주석을 깨뜨린다.)
 *
 *   early  : 문서가 만들어지는 순간 주입(WebViewCompat.addDocumentStartJavaScript).
 *            DOM이 준비될 때까지 콘솔 로그·오류를 모아 두었다가 eruda를 띄운 뒤 콘솔 탭에 다시 보여 준다.
 *   auto   : 페이지를 다 읽은 뒤 주입(문서 시작 주입을 못 쓰는 WebView용 대체 경로). 초기화만 한다.
 *   toggle : 개발자 도구 창 열기/닫기. 아직 없으면 불러와 초기화한 뒤 연다.
 *
 * 결과: 'ready'(초기화됨) | 'pending'(DOM 준비 후 초기화) | 'unavailable'(eruda 코드가 없음) | 'frame'(iframe)
 */

// 1) eruda 코드를 함수로 감싸 둔다. eruda는 불러오는 순간 DOM을 만지므로 문서 시작 시점에는 실행하지 않는다.
//    define/exports/module을 가려야 페이지에 AMD 로더(require.js 등)가 있어도 window.eruda에 붙는다.
(function (define, exports, module) {
  if (window.top !== window || window.eruda || window.__devtoolsBrowserLoad) return;
  window.__devtoolsBrowserLoad = function () {
//@@ERUDA@@
  };
}).call(window);

// 2) 불러오기·초기화·표시
(function (mode) {
  if (window.top !== window) return 'frame';

  var state = window.__devtoolsBrowser;
  if (!state) {
    state = window.__devtoolsBrowser = {};
    if (mode === 'early') bufferConsole(state);
  }

  whenDomReady(function () {
    try {
      var E = loadEruda();
      if (!E) {
        restoreConsole(state);
        return;
      }
      if (!E._isInit) {
        restoreConsole(state);
        E.init();
        replayBuffered(state, E);
        watchBlockedStyles(E);
      }
      if (mode === 'toggle') {
        var dev = E._devTools;
        if (dev && typeof dev.toggle === 'function') dev.toggle();
        else E.show();
      }
    } catch (err) {
      restoreConsole(state);
      console.error('[DevTools Browser] eruda를 띄우지 못했습니다:', err);
    }
  });

  if (window.eruda && window.eruda._isInit) return 'ready';
  if (!window.eruda && typeof window.__devtoolsBrowserLoad !== 'function') return 'unavailable';
  return 'pending';

  function loadEruda() {
    if (!window.eruda && typeof window.__devtoolsBrowserLoad === 'function') {
      var load = window.__devtoolsBrowserLoad;
      window.__devtoolsBrowserLoad = undefined;
      allowHtmlUnderTrustedTypes();
      load.call(window);
    }
    var E = window.eruda;
    return E && typeof E.init === 'function' ? E : null;
  }

  function whenDomReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function once() {
        document.removeEventListener('DOMContentLoaded', once);
        fn();
      });
    } else {
      fn();
    }
  }

  // eruda가 뜨기 전에 찍힌 로그를 놓치지 않도록 console.*와 전역 오류를 잠시 받아 둔다.
  function bufferConsole(s) {
    var MAX = 1000;
    s.buf = [];
    s.orig = {};
    s.wrap = {};
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (type) {
      var original = console[type];
      if (typeof original !== 'function') return;
      var wrapper = function () {
        if (s.buf && s.buf.length < MAX) s.buf.push([type, Array.prototype.slice.call(arguments)]);
        return original.apply(this, arguments);
      };
      s.orig[type] = original;
      s.wrap[type] = wrapper;
      console[type] = wrapper;
    });
    s.onError = function (e) {
      if (s.buf && s.buf.length < MAX) s.buf.push(['error', [e.error || 'Uncaught ' + e.message]]);
    };
    // eruda 자신도 이유(reason)만 넘긴다. 앞에 글자를 붙이면 Error 객체가 접힌 채로만 보인다.
    s.onRejection = function (e) {
      if (s.buf && s.buf.length < MAX) s.buf.push(['error', [e.reason]]);
    };
    window.addEventListener('error', s.onError);
    window.addEventListener('unhandledrejection', s.onRejection);
  }

  // eruda.init()이 진짜 console 함수를 감싸도록 먼저 원래대로 돌려 놓는다.
  // 그 사이 페이지가 console.*를 직접 바꿔 놓았다면 그건 건드리지 않는다.
  function restoreConsole(s) {
    if (!s.orig) return;
    for (var type in s.orig) {
      if (console[type] === s.wrap[type]) console[type] = s.orig[type];
    }
    window.removeEventListener('error', s.onError);
    window.removeEventListener('unhandledrejection', s.onRejection);
    s.orig = null;
    s.wrap = null;
  }

  function replayBuffered(s, E) {
    var buf = s.buf;
    s.buf = null;
    if (!buf || !buf.length) return;
    var con = E.get('console');
    if (!con) return;
    for (var i = 0; i < buf.length; i++) {
      var fn = typeof con[buf[i][0]] === 'function' ? con[buf[i][0]] : con.log;
      try {
        fn.apply(con, buf[i][1]);
      } catch (ignored) {}
    }
  }

  // style-src에 'unsafe-inline'이 없는 페이지에서는 eruda가 넣는 <style>과 style="..."이 막혀 화면이 깨진다.
  // <style> 내용은 생성형 스타일시트(adoptedStyleSheets)로, style 속성은 CSSOM(el.style.cssText)으로 다시 넣는다.
  // 둘 다 CSP가 막지 않는다. eruda 본체(#eruda)·요소 강조 오버레이(chobitsu)의 섀도 루트와
  // 문서에 eruda가 넣은 <style>(아이콘 글꼴 등)만 다루고, 페이지 자체 스타일은 건드리지 않는다.
  function watchBlockedStyles(E) {
    if (typeof CSSStyleSheet !== 'function' || !('replaceSync' in CSSStyleSheet.prototype)) return;
    var host = document.getElementById('eruda');
    if (!host || !host.shadowRoot || !hasBlockedStyle(host.shadowRoot)) return; // 인라인 스타일이 허용된 페이지
    if ('adoptedStyleSheets' in document) mirrorStyles(document, document.head || document.documentElement, false);
    scanRoots();
    new MutationObserver(scanRoots).observe(document.documentElement, { childList: true });
    // 초기화하는 동안에는 스타일이 없어서 첫 탭이 '보이는 상태'로 잘못 계산됐다. 스타일을 입힌 뒤 다시 연다.
    var dev = E._devTools;
    if (dev && dev._curTool && typeof dev.showTool === 'function') {
      var current = dev._curTool;
      dev._curTool = null;
      dev.showTool(current);
    }
  }

  function scanRoots() {
    var kids = document.documentElement.children;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var root = el.shadowRoot;
      if (!root || root.__devtoolsBrowserStyles || !('adoptedStyleSheets' in root)) continue;
      if (el.id !== 'eruda' && String(el.className).indexOf('chobitsu') < 0) continue;
      root.__devtoolsBrowserStyles = true;
      mirrorStyles(root, root, true);
    }
  }

  function hasBlockedStyle(root) {
    var list = root.querySelectorAll('style');
    for (var i = 0; i < list.length; i++) if (!list[i].sheet) return true;
    return false;
  }

  // root: 섀도 루트 또는 document. watchNode 아래 변화를 지켜보며 막힌 스타일을 다시 넣는다.
  function mirrorStyles(root, watchNode, isShadow) {
    var made = typeof WeakMap === 'function' ? new WeakMap() : new Map();
    var ours = [];
    var queued = false;

    var sync = function () {
      queued = false;
      var list = root.querySelectorAll('style');
      var adopted = [];
      for (var i = 0; i < list.length; i++) {
        var st = list[i];
        if (st.sheet) continue;
        if (!isShadow && st.textContent.indexOf('eruda') < 0) continue; // 문서 쪽은 eruda가 넣은 것만
        var entry = made.get(st);
        if (!entry) {
          entry = { sheet: new CSSStyleSheet(), text: null };
          made.set(st, entry);
        }
        if (entry.text !== st.textContent) {
          entry.text = st.textContent;
          try {
            entry.sheet.replaceSync(entry.text);
          } catch (ignored) {}
        }
        adopted.push(entry.sheet);
      }
      // 페이지가 직접 붙인 생성형 스타일시트는 그대로 두고 우리 것만 바꾼다.
      var keep = [];
      var current = root.adoptedStyleSheets;
      for (var k = 0; k < current.length; k++) if (ours.indexOf(current[k]) < 0) keep.push(current[k]);
      ours = adopted;
      root.adoptedStyleSheets = keep.concat(adopted);
    };

    var fixAttr = function (el) {
      if (el.nodeType !== 1 || !el.hasAttribute('style')) return;
      var value = el.getAttribute('style');
      // 적용된 스타일은 속성과 cssText가 같다. 다르면 막힌 것이다. 다시 넣으면 속성이 cssText와 같아져 반복되지 않는다.
      if (value !== el.style.cssText) el.style.cssText = value;
    };
    var fixTree = function (node) {
      fixAttr(node);
      if (!node.querySelectorAll) return;
      var list = node.querySelectorAll('[style]');
      for (var i = 0; i < list.length; i++) fixAttr(list[i]);
    };

    sync();
    if (isShadow) fixTree(root);
    new MutationObserver(function (records) {
      if (isShadow) {
        for (var i = 0; i < records.length; i++) {
          var rec = records[i];
          if (rec.type === 'attributes') fixAttr(rec.target);
          else for (var j = 0; j < rec.addedNodes.length; j++) fixTree(rec.addedNodes[j]);
        }
      }
      if (queued) return;
      queued = true;
      (window.requestAnimationFrame || setTimeout)(sync);
    }).observe(
      watchNode,
      isShadow
        ? { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] }
        : { childList: true, subtree: true, characterData: true }
    );
  }

  // Trusted Types를 강제하는 페이지(require-trusted-types-for 'script')에서는 eruda의 innerHTML 대입이 막힌다.
  // 실제로 막힐 때만 기본 정책을 만들어 둔다. CSP가 'default' 정책 이름을 허용하지 않으면 그대로 둔다.
  function allowHtmlUnderTrustedTypes() {
    try {
      document.createElement('div').innerHTML = '<b></b>';
      return;
    } catch (blocked) {}
    var tt = window.trustedTypes;
    if (!tt || typeof tt.createPolicy !== 'function' || tt.defaultPolicy) return;
    try {
      var same = function (v) {
        return v;
      };
      tt.createPolicy('default', { createHTML: same, createScript: same, createScriptURL: same });
    } catch (ignored) {}
  }
})('@@MODE@@');
