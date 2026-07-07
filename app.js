/* =====================================================================
   就労ナビAI「ココマデ」 デモアプリ (フェーズ1: 音声＋手動報告版)
   設計書 v1.0 準拠のプロトタイプ。

   中核原則(全フェーズ不変):
   1. 回答は「手順書・進捗ログ・意図ログ」の記録からのみ抽出する
   2. 記録にない質問には「記録がありません」と答える(推測禁止)
   3. すべての回答に出典を付ける  例: (進捗ログ 14:02 / 手順書 工程3)

   ※ デモ版のためAI応答はローカルの照合エンジンで実装している。
     実証版では同じ記録データをAnthropic APIに渡す(設計書5.2)。
   ===================================================================== */

"use strict";

/* ---------------- 状態 ---------------- */

const state = {
  procedure: {
    work_name: "請求書データ入力",
    steps: [
      { step_no: 1, title: "伝票の仕分け",   description: "受け取った伝票を取引先ごとに分ける", standard_minutes: 10, completion_sign: "仕分けトレイが空になった" },
      { step_no: 2, title: "データ入力",     description: "会計ソフトに金額と日付を入力する",   standard_minutes: 15, completion_sign: "保存ボタンを押した" },
      { step_no: 3, title: "印刷・確認",     description: "入力結果を印刷し、伝票と見比べる",   standard_minutes: 10, completion_sign: "印刷物と画面を見比べた" },
      { step_no: 4, title: "上長へ提出",     description: "確認済みの書類を提出箱に入れる",     standard_minutes: 5,  completion_sign: "提出箱に入れた" },
      { step_no: 5, title: "日報の記入",     description: "今日の作業内容を日報に書く",         standard_minutes: 10, completion_sign: "日報を保存した" },
    ],
  },
  progressLog: [], // {step_no, status, detail, reported_by, timestamp, source_ref}
  intentLog: [],   // {spoken_text, timestamp, context_step, resolved}
  qaLog: [],       // {question, answer, answered, timestamp}
  alerts: [],      // 支援員向け通知
  currentStepIdx: 0,
  away: false,
  finished: false,
  settings: {
    graceFactor: 1.2,
    speechRate: 0.9,
    demoMode: true,
    demoSecPerMin: 2, // デモモード: 1分 → 2秒
    idleSeconds: 30,  // 擬似中断検知(設計書5.3)
  },
  timer: {
    stepStartedAt: null,
    deadline: null,
    promptOpen: false,
    promptAskedAt: null,
    noResponseCount: 0,
  },
  lastInteraction: Date.now(),
  idleAsked: false,
  lastSpoken: "",
};

/* ---------------- ユーティリティ ---------------- */

const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function agoText(ts) {
  const sec = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}秒前`;
  return `${Math.round(sec / 60)}分前`;
}

function stepDurationMs(step) {
  const s = state.settings;
  return s.demoMode
    ? step.standard_minutes * s.demoSecPerMin * 1000
    : step.standard_minutes * 60 * 1000;
}

function currentStep() { return state.procedure.steps[state.currentStepIdx] || null; }
function nextStep()    { return state.procedure.steps[state.currentStepIdx + 1] || null; }

/* ---------------- 音声出力 (Web Speech API) ---------------- */

function speak(text) {
  state.lastSpoken = text;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  u.rate = state.settings.speechRate;
  window.speechSynthesis.speak(u);
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const play = (freq, start, dur) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + start + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur);
    };
    play(784, 0, 0.35);   // G5
    play(1047, 0.2, 0.5); // C6
  } catch (_) { /* 音が出なくても続行 */ }
}

/* ---------------- 記録 ---------------- */

function logProgress(stepNo, status, detail, reportedBy, sourceRef) {
  state.progressLog.push({
    step_no: stepNo, status, detail: detail || "",
    reported_by: reportedBy, timestamp: Date.now(),
    source_ref: sourceRef,
  });
  renderDashboard();
}

function logIntent(text) {
  state.intentLog.push({
    spoken_text: text,
    timestamp: Date.now(),
    context_step: currentStep() ? currentStep().step_no : null,
    resolved: false,
  });
  renderDashboard();
}

function logQA(question, answer, answered) {
  state.qaLog.push({ question, answer, answered, timestamp: Date.now() });
  renderDashboard();
}

function addAlert(text) {
  state.alerts.push({ text, timestamp: Date.now() });
  renderDashboard();
}

/* ---------------- 照合型応答エンジン (設計書5.2のローカル実装) ----------------
   回答は記録(手順書・進捗ログ・意図ログ)からのみ生成し、必ず出典を付ける。
   どのルールにも一致しない質問には「記録がありません」と答える。 */

function answerQuestion(q) {
  const text = (q || "").trim();
  if (!text) return null;
  const cur = currentStep();
  const nxt = nextStep();

  // 1) 意図の再生: 「何しようとしてたっけ?」
  if (/何(を)?(しよう|やろう)|しようとして|やろうとして|意図|さっきの一言|なにするんだっけ|何するんだっけ/.test(text)) {
    const intent = [...state.intentLog].reverse().find((i) => !i.resolved) || state.intentLog[state.intentLog.length - 1];
    if (intent) {
      intent.resolved = true;
      return {
        text: `${agoText(intent.timestamp)}に「${intent.spoken_text}」と言っていました。`,
        source: `(意図ログ ${fmtTime(intent.timestamp)})`,
      };
    }
    return { text: "記録がありません。", source: null };
  }

  // 2) 進捗の照会: 「今どこ?」「どこまでやった?」
  if (/今どこ|どこまで|進捗|現在|いまどこ|今なに|今何/.test(text)) {
    if (state.finished) {
      const last = state.progressLog[state.progressLog.length - 1];
      return {
        text: `「${state.procedure.work_name}」は全部の工程が終わっています。`,
        source: `(進捗ログ ${fmtTime(last.timestamp)})`,
      };
    }
    if (cur) {
      const started = [...state.progressLog].reverse().find((p) => p.step_no === cur.step_no && p.status === "started");
      const srcTime = started ? fmtTime(started.timestamp) : fmtTime(Date.now());
      return {
        text: `今は 工程${cur.step_no}「${cur.title}」です。`,
        source: `(進捗ログ ${srcTime} / 手順書 工程${cur.step_no})`,
      };
    }
    return { text: "記録がありません。", source: null };
  }

  // 3) 次の一歩の提示: 「次は?」
  if (/次|つぎ|そのあと|その後/.test(text)) {
    if (state.finished) {
      return { text: "全部の工程が終わっています。お疲れさまでした。", source: `(手順書 全${state.procedure.steps.length}工程)` };
    }
    if (nxt) {
      return {
        text: `次は 工程${nxt.step_no}「${nxt.title}」です。${nxt.description}。`,
        source: `(手順書 工程${nxt.step_no})`,
      };
    }
    if (cur) {
      return { text: `工程${cur.step_no}「${cur.title}」が最後の工程です。`, source: `(手順書 工程${cur.step_no})` };
    }
    return { text: "記録がありません。", source: null };
  }

  // 4) 完了確認: 「工程1終わった?」
  const mDone = text.match(/工程\s*(\d+).*(終わ|おわ|完了|できた)/);
  if (mDone) {
    const no = Number(mDone[1]);
    const done = [...state.progressLog].reverse().find((p) => p.step_no === no && p.status === "done");
    const step = state.procedure.steps.find((s) => s.step_no === no);
    if (done && step) {
      return { text: `はい。工程${no}「${step.title}」は終わっています。`, source: `(進捗ログ ${fmtTime(done.timestamp)})` };
    }
    if (step) {
      return { text: `工程${no}「${step.title}」の完了は、まだ記録されていません。`, source: `(手順書 工程${no})` };
    }
    return { text: "記録がありません。", source: null };
  }

  // 5) 完了の目印: 「終わりの目印は?」
  if (/目印|めじるし|どうなったら/.test(text) && cur) {
    return {
      text: `工程${cur.step_no}の終わりの目印は「${cur.completion_sign}」です。`,
      source: `(手順書 工程${cur.step_no})`,
    };
  }

  // 6) どのルールにも一致しない → 知ったかぶりをしない (デモの山場)
  return { text: "記録がありません。", source: null };
}

/* ---------------- 応答の表示・読み上げ ---------------- */

function showResponse(text, source) {
  $("response-area").classList.remove("hidden");
  $("response-text").textContent = text;
  const srcEl = $("response-source");
  if (source) {
    srcEl.textContent = `出典 ${source}`;
    srcEl.classList.remove("none");
  } else {
    srcEl.textContent = "出典なし → 記録限定ルールにより回答しません";
    srcEl.classList.add("none");
  }
  speak(text);
}

function handleQuestion(q) {
  const res = answerQuestion(q);
  if (!res) return;
  showResponse(res.text, res.source);
  logQA(q, res.text, true);
}

/* ---------------- 工程の進行 ---------------- */

function startStep(idx, reportedBy) {
  state.currentStepIdx = idx;
  const step = currentStep();
  if (!step) return;
  const now = Date.now();
  state.timer.stepStartedAt = now;
  state.timer.deadline = now + stepDurationMs(step) * state.settings.graceFactor;
  state.timer.promptOpen = false;
  state.timer.noResponseCount = 0;
  logProgress(step.step_no, "started", "", reportedBy, `工程${step.step_no}開始`);
  renderNav();
}

function completeCurrentStep(reportedBy) {
  const step = currentStep();
  if (!step || state.finished) return;
  logProgress(step.step_no, "done", "", reportedBy, reportedBy === "self" ? "本人の完了報告" : "問いかけへの応答");
  closePrompt();
  if (state.currentStepIdx + 1 < state.procedure.steps.length) {
    startStep(state.currentStepIdx + 1, "system");
    const ns = currentStep();
    speak(`工程${step.step_no}、お疲れさまでした。次は 工程${ns.step_no}、${ns.title}です。`);
  } else {
    state.finished = true;
    state.timer.deadline = null;
    speak(`工程${step.step_no}、お疲れさまでした。今日の作業は全部終わりました。`);
    renderNav();
  }
}

/* ---------------- プッシュ型問いかけ (設計書5.1) ---------------- */

function firePrompt() {
  const step = currentStep();
  if (!step) return;
  state.timer.promptOpen = true;
  state.timer.promptAskedAt = Date.now();
  const q = `工程${step.step_no}の${step.title}は終わりましたか?`;
  $("prompt-question").textContent = q;
  $("modal-prompt").classList.remove("hidden");
  chime();
  speak(q);
}

function closePrompt() {
  state.timer.promptOpen = false;
  $("modal-prompt").classList.add("hidden");
}

function promptNotYet() {
  const step = currentStep();
  closePrompt();
  state.timer.noResponseCount = 0;
  // タイマーを50%延長して再セット
  state.timer.deadline = Date.now() + stepDurationMs(step) * 0.5;
  logQA(`工程${step.step_no}は終わりましたか?`, "まだ", true);
  speak("了解しました。続けてください。");
}

function promptNoResponse() {
  state.timer.noResponseCount += 1;
  const step = currentStep();
  if (state.timer.noResponseCount >= 2) {
    closePrompt();
    state.timer.deadline = Date.now() + stepDurationMs(step) * 0.5;
    addAlert(`⚠ 工程${step.step_no}「${step.title}」への問いかけに2回応答がありません。様子を確認してください。(${fmtTime(Date.now())})`);
    logQA(`工程${step.step_no}は終わりましたか?`, "(無応答×2 → 支援員に通知)", false);
  } else {
    state.timer.promptAskedAt = Date.now();
    chime();
    speak(`もう一度おたずねします。工程${step.step_no}の${step.title}は終わりましたか?`);
    logQA(`工程${step.step_no}は終わりましたか?`, "(無応答)", false);
  }
}

/* ---------------- 意図宣言 (設計書3.3) ---------------- */

let intentAfterSave = null; // 保存後の処理(離席にするか)

function openIntentModal(setAway) {
  intentAfterSave = { setAway };
  $("intent-live").textContent = "";
  $("intent-text").value = "";
  $("modal-intent").classList.remove("hidden");
  speak("一言どうぞ");
}

function saveIntent() {
  const live = $("intent-live").textContent.trim();
  const typed = $("intent-text").value.trim();
  const text = typed || live;
  if (!text) {
    speak("聞き取れませんでした。もう一度お願いします。");
    $("intent-live").textContent = "（聞き取れませんでした — もう一度録音するか、入力してください）";
    return;
  }
  logIntent(text);
  $("modal-intent").classList.add("hidden");
  if (intentAfterSave && intentAfterSave.setAway) {
    state.away = true;
    renderNav();
  }
  speak(`「${text}」を保存しました。いってらっしゃい。`);
}

/* ---------------- 音声認識 (Web Speech API) ---------------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function listenOnce(onResult, onStatus) {
  if (!SR) {
    onStatus("この端末では音声認識が使えません。文字で入力してください。");
    return null;
  }
  const rec = new SR();
  rec.lang = "ja-JP";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => onResult(e.results[0][0].transcript);
  rec.onerror = (e) => onStatus(e.error === "not-allowed"
    ? "マイクの使用が許可されていません。"
    : "聞き取れませんでした。もう一度どうぞ。");
  rec.onend = () => onStatus("", true);
  try { rec.start(); } catch (_) {}
  return rec;
}

// 音声コマンドの振り分け
function routeVoice(text) {
  if (/終わりました|おわりました|できました|完了/.test(text)) {
    completeCurrentStep("self");
    return;
  }
  if (/行ってきます|いってきます|離席/.test(text)) {
    openIntentModal(true);
    return;
  }
  handleQuestion(text);
}

/* ---------------- 描画: 本人ナビ ---------------- */

function renderNav() {
  const cur = currentStep();
  const nxt = nextStep();

  $("away-banner").classList.toggle("hidden", !state.away);
  $("nav-main").style.opacity = state.away ? 0.35 : 1;

  if (state.finished) {
    $("current-step-title").textContent = "🎉 今日の作業はすべて終わりました";
    $("current-step-detail").textContent = `${state.procedure.work_name}（全${state.procedure.steps.length}工程）`;
    $("next-step-title").textContent = "お疲れさまでした";
  } else if (cur) {
    $("current-step-title").textContent = `■ 工程${cur.step_no}: ${cur.title}`;
    $("current-step-detail").textContent = cur.description;
    $("next-step-title").textContent = nxt
      ? `工程${nxt.step_no} ${nxt.title}`
      : "これが最後の工程です";
  }

  // 進捗ドット
  const bar = $("step-progress");
  bar.innerHTML = "";
  state.procedure.steps.forEach((s, i) => {
    const dot = document.createElement("div");
    dot.className = "dot" +
      (state.finished || i < state.currentStepIdx ? " done" :
       i === state.currentStepIdx ? " now" : "");
    dot.title = `工程${s.step_no} ${s.title}`;
    bar.appendChild(dot);
  });

  $("demo-bar").classList.toggle("hidden", !state.settings.demoMode);
}

/* ---------------- 描画: 支援員ダッシュボード ---------------- */

function renderDashboard() {
  const alertArea = $("alert-area");
  alertArea.innerHTML = "";
  state.alerts.forEach((a) => {
    const div = document.createElement("div");
    div.className = "alert-item";
    div.textContent = a.text;
    alertArea.appendChild(div);
  });

  const items = [
    ...state.progressLog.map((p) => ({
      t: p.timestamp, tag: "進捗", cls: "progress",
      text: `工程${p.step_no} ${p.status === "done" ? "完了" : "開始"}（${p.reported_by === "self" ? "本人報告" : p.reported_by === "system_prompted" ? "問いかけ応答" : "システム"}） — ${p.source_ref}`,
    })),
    ...state.intentLog.map((i) => ({
      t: i.timestamp, tag: "意図", cls: "intent",
      text: `「${i.spoken_text}」（工程${i.context_step}の途中）${i.resolved ? " ✔再生済み" : ""}`,
    })),
    ...state.qaLog.map((q) => ({
      t: q.timestamp, tag: "Q&A", cls: "qa",
      text: `Q:「${q.question}」 → A:「${q.answer}」`,
    })),
  ].sort((a, b) => b.t - a.t);

  const ul = $("timeline");
  ul.innerHTML = "";
  if (items.length === 0) {
    ul.innerHTML = '<li><span class="tl-time">--:--</span><span class="tl-tag system">情報</span>まだ記録がありません</li>';
    return;
  }
  items.forEach((it) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="tl-time">${fmtTime(it.t)}</span><span class="tl-tag ${it.cls}">${it.tag}</span><span>${escapeHtml(it.text)}</span>`;
    ul.appendChild(li);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- 描画: 手順書登録 ---------------- */

function renderProcedureForm() {
  $("work-name").value = state.procedure.work_name;
  const tbody = $("step-rows");
  tbody.innerHTML = "";
  state.procedure.steps.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.step_no}</td>
      <td><input data-i="${i}" data-k="title" value="${escapeHtml(s.title)}"></td>
      <td><input data-i="${i}" data-k="description" value="${escapeHtml(s.description)}"></td>
      <td class="col-min"><input data-i="${i}" data-k="standard_minutes" type="number" min="1" value="${s.standard_minutes}"></td>
      <td><input data-i="${i}" data-k="completion_sign" value="${escapeHtml(s.completion_sign)}"></td>
      <td><button class="btn-del" data-del="${i}" title="削除">🗑</button></td>`;
    tbody.appendChild(tr);
  });
}

function readProcedureForm() {
  state.procedure.work_name = $("work-name").value.trim() || "無題の作業";
  document.querySelectorAll("#step-rows input").forEach((inp) => {
    const i = Number(inp.dataset.i);
    const k = inp.dataset.k;
    if (!state.procedure.steps[i]) return;
    state.procedure.steps[i][k] = k === "standard_minutes" ? Math.max(1, Number(inp.value) || 1) : inp.value;
  });
  state.procedure.steps.forEach((s, i) => { s.step_no = i + 1; });
}

/* ---------------- タイマー監視ループ ---------------- */

function tick() {
  const t = state.timer;
  const now = Date.now();

  // プッシュ型問いかけの発火
  if (!state.finished && !state.away && t.deadline && !t.promptOpen && now >= t.deadline) {
    firePrompt();
  }

  // 問いかけへの無応答チェック(デモ: 15秒)
  if (t.promptOpen && now - t.promptAskedAt > 15000) {
    promptNoResponse();
  }

  // 擬似中断検知(設計書5.3): 一定時間操作がない
  if (!state.finished && !state.away && !t.promptOpen && !state.idleAsked &&
      isNavVisible() && noModalOpen() &&
      now - state.lastInteraction > state.settings.idleSeconds * 1000) {
    state.idleAsked = true;
    $("modal-idle").classList.remove("hidden");
    chime();
    speak("作業を中断していますか? 一言残しますか?");
  }

  // デモバーの残り時間表示
  if (state.settings.demoMode) {
    const info = $("timer-info");
    if (state.finished) {
      info.textContent = "全工程完了";
    } else if (t.deadline && !t.promptOpen) {
      const remain = Math.max(0, Math.ceil((t.deadline - now) / 1000));
      info.textContent = `問いかけまで あと${remain}秒（1分→${state.settings.demoSecPerMin}秒に短縮中）`;
    } else if (t.promptOpen) {
      info.textContent = "問いかけ中…";
    }
  }
}

function isNavVisible() { return !$("view-nav").classList.contains("hidden"); }
function noModalOpen() {
  return ["modal-prompt", "modal-intent", "modal-idle"].every((id) => $(id).classList.contains("hidden"));
}

/* ---------------- イベント ---------------- */

function bindEvents() {
  // 操作があれば中断検知タイマーをリセット
  ["click", "keydown", "input"].forEach((ev) =>
    document.addEventListener(ev, () => {
      state.lastInteraction = Date.now();
      state.idleAsked = false;
    })
  );

  // ビュー切替
  $("tab-nav").addEventListener("click", () => switchView("nav"));
  $("tab-staff").addEventListener("click", () => switchView("staff"));

  // 支援員サブタブ
  document.querySelectorAll(".staff-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".staff-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".staff-panel").forEach((p) => p.classList.add("hidden"));
      $(btn.dataset.panel).classList.remove("hidden");
    });
  });

  // 本人ナビ: 3ボタン
  $("btn-done").addEventListener("click", () => completeCurrentStep("self"));
  $("btn-where").addEventListener("click", () => handleQuestion("今どこ?"));
  $("btn-away").addEventListener("click", () => openIntentModal(true));
  $("btn-return").addEventListener("click", () => {
    state.away = false;
    renderNav();
    const pending = [...state.intentLog].reverse().find((i) => !i.resolved);
    if (pending) {
      speak("おかえりなさい。何をしようとしていたか、聞きたいときは「何しようとしてたっけ」と話しかけてください。");
    } else {
      speak("おかえりなさい。");
    }
  });

  // 質問
  $("btn-ask").addEventListener("click", () => {
    const q = $("ask-input").value.trim();
    if (q) { handleQuestion(q); $("ask-input").value = ""; }
  });
  $("ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-ask").click();
  });
  $("btn-replay").addEventListener("click", () => speak(state.lastSpoken));

  // マイク(質問・コマンド)
  $("btn-mic").addEventListener("click", () => {
    $("btn-mic").classList.add("listening");
    $("mic-status").textContent = "聞いています…";
    listenOnce(
      (text) => {
        $("mic-status").textContent = `聞き取り:「${text}」`;
        routeVoice(text);
      },
      (msg, ended) => {
        if (ended) $("btn-mic").classList.remove("listening");
        if (msg) $("mic-status").textContent = msg;
      }
    );
  });

  // 問いかけモーダル
  $("prompt-yes").addEventListener("click", () => {
    const step = currentStep();
    logQA(`工程${step.step_no}は終わりましたか?`, "はい", true);
    closePrompt();
    // reported_by: system_prompted として記録(設計書5.1)
    logProgress(step.step_no, "done", "", "system_prompted", "問いかけへの応答");
    if (state.currentStepIdx + 1 < state.procedure.steps.length) {
      startStep(state.currentStepIdx + 1, "system");
      const ns = currentStep();
      speak(`記録しました。次は 工程${ns.step_no}、${ns.title}です。`);
    } else {
      state.finished = true;
      state.timer.deadline = null;
      speak("記録しました。今日の作業は全部終わりました。");
      renderNav();
    }
  });
  $("prompt-notyet").addEventListener("click", promptNotYet);
  $("prompt-help").addEventListener("click", () => {
    const step = currentStep();
    closePrompt();
    state.timer.deadline = Date.now() + stepDurationMs(step) * 0.5;
    addAlert(`🙋 工程${step.step_no}「${step.title}」でヘルプ要請がありました。(${fmtTime(Date.now())})`);
    logQA(`工程${step.step_no}は終わりましたか?`, "ヘルプ", true);
    speak("支援員に知らせました。少し待っていてください。");
  });

  // 意図宣言モーダル
  $("intent-rec").addEventListener("click", () => {
    $("intent-rec").classList.add("listening");
    $("intent-live").textContent = "🎙 聞いています…（最大10秒）";
    const rec = listenOnce(
      (text) => { $("intent-live").textContent = text; },
      (msg, ended) => {
        if (ended) $("intent-rec").classList.remove("listening");
        if (msg) $("intent-live").textContent = msg;
      }
    );
    if (rec) setTimeout(() => { try { rec.stop(); } catch (_) {} }, 10000);
  });
  $("intent-ok").addEventListener("click", saveIntent);
  $("intent-cancel").addEventListener("click", () => $("modal-intent").classList.add("hidden"));

  // 中断検知モーダル
  $("idle-leave").addEventListener("click", () => {
    $("modal-idle").classList.add("hidden");
    openIntentModal(true);
  });
  $("idle-continue").addEventListener("click", () => {
    $("modal-idle").classList.add("hidden");
    speak("了解しました。続けてください。");
  });

  // デモ: 早送り
  $("btn-ff").addEventListener("click", () => {
    if (state.timer.deadline) state.timer.deadline -= 10000;
  });

  // 支援員: 手順書
  $("btn-add-step").addEventListener("click", () => {
    readProcedureForm();
    state.procedure.steps.push({
      step_no: state.procedure.steps.length + 1,
      title: "", description: "", standard_minutes: 5, completion_sign: "",
    });
    renderProcedureForm();
  });
  $("step-rows").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      readProcedureForm();
      state.procedure.steps.splice(Number(del.dataset.del), 1);
      state.procedure.steps.forEach((s, i) => { s.step_no = i + 1; });
      renderProcedureForm();
    }
  });
  $("btn-start-proc").addEventListener("click", () => {
    readProcedureForm();
    if (state.procedure.steps.length === 0) return;
    // 進捗をリセットして工程1から開始
    state.progressLog = [];
    state.intentLog = [];
    state.qaLog = [];
    state.alerts = [];
    state.finished = false;
    state.away = false;
    renderProcedureForm();
    startStep(0, "system");
    switchView("nav");
    speak(`${state.procedure.work_name}を始めます。工程1、${state.procedure.steps[0].title}です。`);
  });

  // 設定
  $("set-grace").addEventListener("change", (e) => {
    state.settings.graceFactor = Math.max(1, Number(e.target.value) || 1.2);
  });
  $("set-rate").addEventListener("input", (e) => {
    state.settings.speechRate = Number(e.target.value);
    $("rate-value").textContent = e.target.value;
  });
  $("set-demo").addEventListener("change", (e) => {
    state.settings.demoMode = e.target.checked;
    renderNav();
  });
  $("set-demo-sec").addEventListener("change", (e) => {
    state.settings.demoSecPerMin = Math.max(1, Number(e.target.value) || 2);
  });
}

function switchView(name) {
  $("view-nav").classList.toggle("hidden", name !== "nav");
  $("view-staff").classList.toggle("hidden", name !== "staff");
  $("tab-nav").classList.toggle("active", name === "nav");
  $("tab-staff").classList.toggle("active", name === "staff");
}

/* ---------------- 起動 ---------------- */

bindEvents();
renderProcedureForm();
renderDashboard();
startStep(0, "system");
setInterval(tick, 500);
