/**
 * LAPSE-CORE: 動画解析（ストロークテンポ）機能の仲介サーバー
 * ------------------------------------------------------------
 * 【v14での方針転換】
 *   これまではGemini AIに動画を見せてストローク回数を「推測」させていたが、
 *   精度に構造的な限界がある（Geminiは動画を1秒1コマでしか見ておらず、
 *   競泳のような速い繰り返し動作を取りこぼしやすい）ことが分かったため、
 *   ストロークのカウント自体はクライアント側（アプリ本体・ブラウザ内）で
 *   MediaPipe Pose Landmarkerを使い、手首の座標を実際に追跡して機械的に
 *   カウントする方式に変更した。これにより：
 *     ・Gemini APIキー・課金・月間分数の管理はもう不要
 *     ・このサーバー側の役割は「解析結果を記録として保存する」「動画を
 *       保管する（保存容量を管理する）」の2つだけになった
 *
 * 前提：
 *   ・Firebase プロジェクトが Blaze（従量課金）プランになっていること
 *     （Cloud Functions自体・Storageの容量課金のため。Gemini課金はもう不要）
 *   ・teams/{teamId} ドキュメントに vaPlan フィールド（'p50'|'p100'|'p200'）を持たせておくこと
 *     （意味が「月間分数」から「保存容量（GB、チーム全体で今までに保存した動画の合計）」に変わった）
 *   ・users/{uid} ドキュメントに role('coach'|'athlete') と teamId が入っていること（既存のスキーマのまま）
 * ------------------------------------------------------------
 */
const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

// 【Polar連携】client_secretはソースコードに直書きせず、Firebase Secret Managerで管理する。
// 初回だけ以下をターミナルで実行してください（値を聞かれるので、admin.polaraccesslink.comで
// 作成したクライアントのIDとシークレットを入力する）：
//   firebase functions:secrets:set POLAR_CLIENT_ID
//   firebase functions:secrets:set POLAR_CLIENT_SECRET
//   firebase functions:secrets:set POLAR_REDIRECT_URI   ← polarOAuthCallbackのデプロイ後に発行されるURLを入れる
const POLAR_CLIENT_ID     = defineSecret('POLAR_CLIENT_ID');
const POLAR_CLIENT_SECRET = defineSecret('POLAR_CLIENT_SECRET');
const POLAR_REDIRECT_URI  = defineSecret('POLAR_REDIRECT_URI');

// 【標準記録・管理者権限】ログイン画面の「招待コード」欄に合言葉を打つと管理者になれる仕組み。
// 合言葉そのものはソースコードに書かず、Secret Managerだけに保持する。
// 初回だけ以下をターミナルで実行し、聞かれたら合言葉を入力する：
//   firebase functions:secrets:set STD_RECORD_ADMIN_CODE
const STD_RECORD_ADMIN_CODE = defineSecret('STD_RECORD_ADMIN_CODE');

// 【今回追加・AI-OCR中継】スタートリスト（PDF/写真）読み取りで使うAnthropic APIキー。
// ブラウザから直接Anthropic APIを呼ぶとCORSでブロックされるため、このCloud Functions
// （callAnthropic、下の方に実装）を経由して中継する。APIキーはソースコードに書かず、
// Secret Managerだけに保持する。初回だけ以下をターミナルで実行し、
// Anthropic Console（https://console.anthropic.com/settings/keys）で発行したAPIキーを
// 聞かれたら貼り付ける：
//   firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

admin.initializeApp();
const db = admin.firestore();
const storage = admin.storage();

// ── プランごとの保存容量上限（バイト） ─────────────────────────
// 【重要】ここのGB数はまだ開発者が決めていない「仮の値」です。実際の価格・容量が
// 決まったら、このオブジェクトの数値だけ書き換えて再デプロイしてください。
const GB = 1024 * 1024 * 1024;
const VA_PLANS = {
  p50:  { storageCapBytes: 50  * GB },
  p100: { storageCapBytes: 150 * GB },
  p200: { storageCapBytes: 300 * GB },
};
const DEFAULT_PLAN = 'p50';
function planOf(team){ return VA_PLANS[team && team.vaPlan] || VA_PLANS[DEFAULT_PLAN]; }

// ── My Note（チャットの写真・動画・ファイル）用の保存容量 ─────────────
// 動画解析用（VA_PLANS）とは別枠。teams/{teamId} の myNotePlan フィールド（'m10'|'m30'|'m60'）で管理する。
// 【重要】このGB数も開発者がまだ決めていない仮の値です。決まり次第、数値だけ書き換えて再デプロイしてください。
const MYNOTE_PLANS = {
  m10: { storageCapBytes: 10 * GB },
  m30: { storageCapBytes: 30 * GB },
  m60: { storageCapBytes: 60 * GB },
};
const MYNOTE_DEFAULT_PLAN = 'm10';
function myNotePlanOf(team){ return MYNOTE_PLANS[team && team.myNotePlan] || MYNOTE_PLANS[MYNOTE_DEFAULT_PLAN]; }
async function getOrInitMyNoteUsage(teamId){
  // 【重要】teams/{teamId}/... の下は既存のFirestoreルールで「同じチームの誰でも読み書きできる」
  // 設定になっているため、容量カウンターは絶対にクライアントから触られたくない＝トップレベルの
  // myNoteUsage コレクションに置き、Cloud Function以外は読み書きできないようルールで絞る。
  const ref = db.collection('myNoteUsage').doc(teamId);
  const snap = await ref.get();
  if (snap.exists) return { ref, data: snap.data() };
  const data = { usedBytes: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  await ref.set(data);
  return { ref, data };
}

/** 呼び出し元が本当にそのチームの監督・マネ・スタッフかどうかを確認する */
async function assertIsCoachOfTeam(uid, teamId) {
  const uSnap = await db.collection('users').doc(uid).get();
  const u = uSnap.data();
  if (!u || u.role !== 'coach' || u.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'この操作は監督・マネ・スタッフのみ行えます');
  }
}

/** 呼び出し元がそのチームに所属しているか（監督・選手どちらでもOK）を確認する */
async function assertIsMemberOfTeam(uid, teamId) {
  const uSnap = await db.collection('users').doc(uid).get();
  const u = uSnap.data();
  if (!u || u.teamId !== teamId) {
    throw new HttpsError('permission-denied', 'このチームのメンバーではありません');
  }
}

/** チームの「保存容量の使用状況」ドキュメントを取得する。無ければ0で新規作成する。
 *  月をまたいでリセットされる値ではなく、チームが今までに保存した動画の合計サイズ（累積）。 */
async function getOrInitStorageUsage(teamId){
  // 【変更】teams/{teamId}/vaUsage/storage → vaUsageData/{teamId}
  //   旧パスは teams/{teamId}/{document=**} という広いワイルドカードルールの対象になっており、
  //   個別に allow write:false と書いてもチームメンバーなら誰でも書き込めてしまう穴があったため、
  //   ワイルドカードの影響を受けないトップレベルのコレクションに移設した（activityFeedと同じ設計）。
  const ref = db.collection('vaUsageData').doc(teamId);
  const snap = await ref.get();
  if (snap.exists) return { ref, data: snap.data() };
  const data = { usedBytes: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  await ref.set(data);
  return { ref, data };
}

// ============================================================
// ① 監督・マネ・スタッフ：動画解析の結果を保存する
//    （ストローク回数のカウント自体は、この関数を呼ぶ前にクライアント側
//     [MediaPipe] で完了済みで、動画自体もこの関数を呼ぶ前にクライアントから
//     Firebase Storageへ直接アップロード済みである前提。
//     ここでは①アップロード済みファイルのサイズを実際に確認し、保存容量の
//     上限を超えていないかチェックしたうえで②結果をFirestoreに記録する）
// ============================================================
exports.saveVaResult = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');

  const { teamId, clipStoragePath, distanceM, clipDurationSec, strokeType, athleteName,
    event, raceFormat, meetName, date, result } = request.data || {};
  if (!teamId || !clipStoragePath || !distanceM || !clipDurationSec || !strokeType || !athleteName || !result) {
    throw new HttpsError('invalid-argument', '必要な情報が不足しています');
  }
  // この操作自体、選手本人ではなく監督・マネージャー・スタッフしか行えない
  await assertIsCoachOfTeam(uid, teamId);

  const bucket = storage.bucket();
  const file = bucket.file(clipStoragePath);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', 'アップロードされた動画が見つかりません');
  const [metadata] = await file.getMetadata();
  const fileSizeBytes = Number(metadata.size) || 0;

  const teamSnap = await db.collection('teams').doc(teamId).get();
  const plan = planOf(teamSnap.data());
  const { ref: usageRef } = await getOrInitStorageUsage(teamId);

  // 保存容量の上限チェック＋加算をトランザクションで（同時アップロードによる超過を防ぐ）
  try {
    await db.runTransaction(async (tx) => {
      const usageSnap = await tx.get(usageRef);
      const usage = usageSnap.data();
      const remaining = plan.storageCapBytes - usage.usedBytes;
      if (remaining < fileSizeBytes) {
        throw new HttpsError('resource-exhausted',
          `保存容量が残り${(remaining / GB).toFixed(2)}GBのため保存できません（この動画は${(fileSizeBytes / GB).toFixed(2)}GB）。古い動画を削除するか、プランの見直しをご検討ください`);
      }
      tx.update(usageRef, {
        usedBytes: usage.usedBytes + fileSizeBytes,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    // 容量超過などで保存できない場合は、アップロード済みの動画ファイル自体を削除しておく
    await file.delete().catch(() => {});
    throw e;
  }

  // 【変更】teams/{teamId}/vaRequests/{id} → vaRequestsData/{teamId}/requests/{id}（理由は上記コメント参照）
  const reqRef = db.collection('vaRequestsData').doc(teamId).collection('requests').doc();
  await reqRef.set({
    submittedBy: uid,
    athleteName: athleteName || '',
    teamId,
    clipStoragePath,
    fileSizeBytes,
    distanceM: Number(distanceM),
    clipDurationSec: Number(clipDurationSec),
    strokeType,
    event: event || '',
    raceFormat: raceFormat || '',
    meetName: meetName || '',
    date: date || '',
    status: 'done',
    result: {
      tempo: Number(result.tempo) || 0,
      speedMs: Number(result.speedMs) || 0,
      pace25: Number(result.pace25) || 0,
      strokeCycles: Number(result.strokeCycles) || 0,
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { requestId: reqRef.id };
});

// ============================================================
// ② 監督・マネ・スタッフ：保存済みの動画を削除し、保存容量を空ける
// ============================================================
exports.deleteVaClip = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  const { teamId, requestId } = request.data || {};
  if (!teamId || !requestId) throw new HttpsError('invalid-argument', 'requestIdが必要です');
  await assertIsCoachOfTeam(uid, teamId);

  const reqRef = db.collection('vaRequestsData').doc(teamId).collection('requests').doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new HttpsError('not-found', '見つかりません');
  const reqData = reqSnap.data();

  if (reqData.clipStoragePath) {
    await storage.bucket().file(reqData.clipStoragePath).delete().catch(() => {});
  }
  const fileSizeBytes = Number(reqData.fileSizeBytes) || 0;
  if (fileSizeBytes > 0) {
    const { ref: usageRef } = await getOrInitStorageUsage(teamId);
    await db.runTransaction(async (tx) => {
      const usageSnap = await tx.get(usageRef);
      const usage = usageSnap.data();
      tx.update(usageRef, { usedBytes: Math.max(0, usage.usedBytes - fileSizeBytes) });
    });
  }
  await reqRef.update({ status: 'deleted', clipStoragePath: admin.firestore.FieldValue.delete(), deletedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true };
});

// ============================================================
// ③ 保存済み動画の再生用URLを発行する（監督・選手どちらも可。チームのメンバーのみ）
// ============================================================
exports.getVaClipUrl = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  const { teamId, requestId } = request.data || {};
  if (!teamId || !requestId) throw new HttpsError('invalid-argument', 'requestIdが必要です');
  await assertIsMemberOfTeam(uid, teamId);

  const reqSnap = await db.collection('vaRequestsData').doc(teamId).collection('requests').doc(requestId).get();
  if (!reqSnap.exists) throw new HttpsError('not-found', '見つかりません');
  const reqData = reqSnap.data();
  if (!reqData.clipStoragePath) throw new HttpsError('not-found', '動画は削除済みです');

  const [url] = await storage.bucket().file(reqData.clipStoragePath).getSignedUrl({
    action: 'read',
    expires: Date.now() + 60 * 60 * 1000, // 1時間だけ有効なURL
  });
  return { url };
});

// ============================================================
// ④ 今月の保存容量の使用状況を取得する（監督・選手どちらも可）
// ============================================================
exports.getVaStorageUsage = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');

  const uSnap = await db.collection('users').doc(uid).get();
  const u = uSnap.data();
  if (!u || !u.teamId) throw new HttpsError('failed-precondition', 'チームに所属していません');

  const teamSnap = await db.collection('teams').doc(u.teamId).get();
  const team = teamSnap.data() || {};
  const plan = planOf(team);
  const { data: usage } = await getOrInitStorageUsage(u.teamId);

  return {
    plan: team.vaPlan || DEFAULT_PLAN,
    capBytes: plan.storageCapBytes,
    usedBytes: usage.usedBytes,
    remainingBytes: plan.storageCapBytes - usage.usedBytes,
  };
});

// ============================================================
// ⑤ 通知：チームの誰か（監督・マネ・スタッフ）がタイマー／ラップ表作成から
//    新しい記録を保存する度に、そのチームの他のメンバー（通知ONの人）へ
//    プッシュ通知を送る。
//    クライアント側は activityFeed/{teamId}/items に1件ドキュメントを作るだけで、
//    実際に「誰に・どんな文面で送るか」はすべてこの関数（サーバー側）で行う。
// ------------------------------------------------------------
// 【通知の文面ルール】
//   ・コメントが空の場合：タイトル＝選手名、本文＝種目（＋競技形式）とタイム
//   ・コメントがある場合：タイトル＝「選手名 コメント」、本文はコメントの有無に関わらず
//     常に種目とタイムを表示する
// ============================================================

/** ミリ秒を "01:23.45" 形式の文字列に変換する（クライアント側のfmt2と同じ書式） */
function formatRaceTime(ms){
  const num = Number(ms) || 0;
  const s = num / 1000;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
}

exports.notifyOnNewActivity = onDocumentCreated('activityFeed/{teamId}/items/{activityId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const activity = snap.data();
  const teamId = event.params.teamId;

  const athleteName = activity.athleteName || '(選手名未設定)';
  const eventLabel = (activity.event || '') + (activity.raceFormat ? ' ' + activity.raceFormat : '');
  const timeLabel = formatRaceTime(activity.timeMs);
  const comment = (activity.comment || '').trim();

  const title = comment ? `${athleteName} ${comment}` : athleteName;
  const body = `${eventLabel}　${timeLabel}`;

  // 通知をタップした時にこの記録の画面を直接開けるよう、遷移に必要な情報をdataに積んでおく
  // （実際にどの記録かを特定するのはクライアント側。名前・種目・タイムの組み合わせで探す）。
  // FCMのdataは値がすべて文字列である必要があるため、数値・undefinedはString化・空文字化する。
  const dataPayload = {
    type: 'record',
    name: athleteName,
    event: activity.event || '',
    timeMs: String(activity.timeMs || 0),
    url: './?openRecord=1'
      + '&name=' + encodeURIComponent(athleteName)
      + '&event=' + encodeURIComponent(activity.event || '')
      + '&timeMs=' + encodeURIComponent(String(activity.timeMs || 0)),
  };

  // 通知対象：同じチームに所属し、notificationsEnabled:true かつ fcmTokensを持っているメンバー
  // （保存した本人には送らない）
  const usersSnap = await db.collection('users')
    .where('teamId', '==', teamId)
    .where('notificationsEnabled', '==', true)
    .get();

  const tokens = [];
  const tokenOwners = []; // { uid, token } のペアで持っておき、無効トークンの掃除に使う
  usersSnap.forEach(doc => {
    if (doc.id === activity.savedByUid) return; // 保存した本人は除外
    const u = doc.data();
    (u.fcmTokens || []).forEach(tok => {
      tokens.push(tok);
      tokenOwners.push({ uid: doc.id, token: tok });
    });
  });
  if (!tokens.length) return;
  await sendPushAndCleanupTokens(tokens, tokenOwners, title, body, dataPayload);
});

/** FCMへのプッシュ送信＋期限切れ・無効トークンの掃除をまとめた共通処理。
 *  notifyOnNewActivity・notifyOnNewMyNoteMessage・notifyOnNewCalendarEventの3箇所で使う。
 *  data（省略可）：通知をタップした時にクライアント側で使う、遷移先などの追加情報。 */
async function sendPushAndCleanupTokens(tokens, tokenOwners, title, body, data) {
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    ...(data ? { data } : {}),
  });
  const invalidByUid = {};
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error && r.error.code;
    if (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered') {
      const { uid, token } = tokenOwners[i];
      (invalidByUid[uid] = invalidByUid[uid] || []).push(token);
    }
  });
  await Promise.all(Object.keys(invalidByUid).map(uid =>
    db.collection('users').doc(uid).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidByUid[uid]),
    }).catch(() => {})
  ));
}
/** 指定uid配列のうち、notificationsEnabled:trueの人だけのfcmTokenを集めて {tokens, tokenOwners} で返す */
async function collectTokensForUids(uids) {
  const tokens = [];
  const tokenOwners = [];
  await Promise.all(uids.map(async uid => {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return;
    const u = snap.data();
    if (!u.notificationsEnabled) return;
    (u.fcmTokens || []).forEach(tok => { tokens.push(tok); tokenOwners.push({ uid, token: tok }); });
  }));
  return { tokens, tokenOwners };
}

// ============================================================
// ⑥ My Note：選手ごとのチャット（写真・動画・ファイル添付）
//    動画解析とは別枠の保存容量（MYNOTE_PLANS）で管理する。
// ============================================================

/** チャットへの写真・動画・ファイル送信。
 *  クライアントは先にFirebase Storageへアップロード済みで、この関数は
 *  ①実際のファイルサイズを確認して容量上限を超えていないかチェックし、
 *  ②メッセージドキュメントをFirestoreに作成する（テキストのみの送信はクライアントから直接書き込むため、
 *    この関数を経由するのは添付がある場合のみ）。
 *  【今回変更】以前は「選手1人につき1本の共有スレッド」だったが、選手がやり取りする相手
 *  （監督・コーチ・スタッフ）を選べるようになったことに伴い、athleteUidに加えてstaffUidも
 *  必須で受け取り、「選手×スタッフ」のペアごとのスレッド（threadId=athleteUid_staffUid）へ
 *  書き込むように変更した。監督・コーチ・スタッフは対象選手との自分のスレッドに、
 *  選手は自分と選んだ相手とのスレッドにのみ送信できる。 */
exports.saveMyNoteAttachment = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  const { teamId, athleteUid, staffUid, storagePath, attachmentType, attachmentName, text } = request.data || {};
  if (!teamId || !athleteUid || !staffUid || !storagePath || !attachmentType) {
    throw new HttpsError('invalid-argument', '必要な情報が不足しています');
  }
  const uSnap = await db.collection('users').doc(uid).get();
  const u = uSnap.data();
  if (!u || u.teamId !== teamId) throw new HttpsError('permission-denied', 'このチームのメンバーではありません');
  const isCoach = u.role === 'coach';
  const isSelf = uid === athleteUid;
  if (!isCoach && !isSelf) throw new HttpsError('permission-denied', '自分以外のノートには送信できません');
  // 【今回追加】監督・コーチ・スタッフは、自分自身をstaffUidとしてしか送信できない
  // （他のスタッフになりすまして送ることはできない）。選手はどのstaffUidでも選べる。
  if (isCoach && staffUid !== uid) throw new HttpsError('permission-denied', '自分以外のスタッフとしては送信できません');

  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', 'アップロードされたファイルが見つかりません');
  const [metadata] = await file.getMetadata();
  const fileSizeBytes = Number(metadata.size) || 0;

  const teamSnap = await db.collection('teams').doc(teamId).get();
  const plan = myNotePlanOf(teamSnap.data());
  const { ref: usageRef } = await getOrInitMyNoteUsage(teamId);

  try {
    await db.runTransaction(async (tx) => {
      const usageSnap = await tx.get(usageRef);
      const usage = usageSnap.data();
      const remaining = plan.storageCapBytes - usage.usedBytes;
      if (remaining < fileSizeBytes) {
        throw new HttpsError('resource-exhausted',
          `保存容量が残り${(remaining / GB).toFixed(2)}GBのため送信できません（このファイルは${(fileSizeBytes / GB).toFixed(2)}GB）`);
      }
      tx.update(usageRef, {
        usedBytes: usage.usedBytes + fileSizeBytes,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    await file.delete().catch(() => {});
    throw e;
  }

  const [url] = await file.getSignedUrl({ action: 'read', expires: '2100-01-01' });
  const threadId = `${athleteUid}_${staffUid}`;
  const msgRef = db.collection('myNoteChats').doc(teamId).collection('chats').doc(threadId).collection('messages').doc();
  await msgRef.set({
    senderUid: uid, senderRole: isCoach ? 'coach' : 'athlete',
    athleteUid, staffUid,
    text: text || '', attachmentType, attachmentUrl: url, attachmentName: attachmentName || '',
    attachmentPath: storagePath, attachmentSizeBytes: fileSizeBytes,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { messageId: msgRef.id };
});

/** My Noteの保存容量の使用状況を取得する（監督・選手どちらも可） */
exports.getMyNoteStorageUsage = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  const uSnap = await db.collection('users').doc(uid).get();
  const u = uSnap.data();
  if (!u || !u.teamId) throw new HttpsError('failed-precondition', 'チームに所属していません');
  const teamSnap = await db.collection('teams').doc(u.teamId).get();
  const team = teamSnap.data() || {};
  const plan = myNotePlanOf(team);
  const { data: usage } = await getOrInitMyNoteUsage(u.teamId);
  return {
    plan: team.myNotePlan || MYNOTE_DEFAULT_PLAN,
    capBytes: plan.storageCapBytes,
    usedBytes: usage.usedBytes,
    remainingBytes: plan.storageCapBytes - usage.usedBytes,
  };
});

/** チャットに新しいメッセージが来たら、相手（送信者と反対側の1人）に通知する。
 *  【今回変更】以前はドキュメントパスの{athleteUid}部分から直接選手uidを取り、
 *  選手が送った場合はチームの監督・コーチ・スタッフ全員に通知していた。
 *  選手がやり取りする相手を1人選べるようになった（athleteUid×staffUidのペアごとの
 *  スレッドになった）ことに伴い、パスの可変部分は実際にはthreadId（athleteUid_staffUid）
 *  になっているため、代わりにメッセージ本体に書き込まれているathleteUid・staffUid
 *  フィールドを使い、選手が送った場合もそのスレッドの相手（staffUid）1人だけに通知する。 */
exports.notifyOnNewMyNoteMessage = onDocumentCreated('myNoteChats/{teamId}/chats/{threadId}/messages/{messageId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const msg = snap.data();
  const teamId = event.params.teamId;
  const athleteUid = msg.athleteUid;
  const staffUid = msg.staffUid;
  if (!athleteUid || !staffUid) return; // 【今回変更前の】古い形式のメッセージ（フィールド無し）は通知対象外

  const bodyText = msg.text || (msg.attachmentType === 'image' ? '[写真を送信しました]' : msg.attachmentType === 'video' ? '[動画を送信しました]' : msg.attachmentType === 'file' ? '[ファイルを送信しました]' : '');

  let targetUid, title;
  if (msg.senderRole === 'coach') {
    // 監督・コーチ・スタッフ→選手本人へ
    targetUid = athleteUid;
    const staffSnap = await db.collection('teams').doc(teamId).collection('staff').doc(staffUid).get();
    title = (staffSnap.exists && staffSnap.data().name) ? `${staffSnap.data().name} からのメッセージ` : 'コーチからのメッセージ';
  } else {
    // 選手→選んだスタッフ1人だけへ（以前は監督・コーチ・スタッフ全員に通知していたが、
    // 選手がやり取り相手を選べるようになったことに合わせ、選んだ相手だけに絞った）
    targetUid = staffUid;
    const athleteSnap = await db.collection('teams').doc(teamId).collection('athletes').doc(athleteUid).get();
    title = (athleteSnap.exists && athleteSnap.data().name) ? `${athleteSnap.data().name} からのメッセージ` : '選手からのメッセージ';
  }
  if (!targetUid || targetUid === msg.senderUid) return;
  const { tokens, tokenOwners } = await collectTokensForUids([targetUid]);
  if (!tokens.length) return;
  await sendPushAndCleanupTokens(tokens, tokenOwners, title, bodyText);
});

// ============================================================
// ⑦ My Note：カレンダー（監督が共有した予定を作成したら、チーム全員に通知する）
// ============================================================
exports.notifyOnNewCalendarEvent = onDocumentCreated('sharedCalendars/{teamId}/events/{eventId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const ev = snap.data();
  const teamId = event.params.teamId;

  const athletesSnap = await db.collection('users').where('teamId', '==', teamId).where('role', '==', 'athlete').get();
  const targetUids = athletesSnap.docs.map(d => d.id).filter(id => id !== ev.createdBy);
  if (!targetUids.length) return;
  const { tokens, tokenOwners } = await collectTokensForUids(targetUids);
  if (!tokens.length) return;
  const timeLabel = ev.allDay ? '終日' : `${ev.startTime || ''}${ev.endTime ? '〜' + ev.endTime : ''}`;
  await sendPushAndCleanupTokens(tokens, tokenOwners, '新しい予定が共有されました', `${ev.title || ''}　${ev.date || ''} ${timeLabel}`);
});

// ============================================================
// ⑧ My Note：トレーニングデータ（Polarなどのスクリーンショット＋数値）
//    My Noteのチャット添付と同じ保存容量（MYNOTE_PLANS）を共有する。
//    写真自体はクライアントが直接Storageへアップロード済みで、
//    この関数は①容量チェック②署名付きURLの発行のみ行う
//    （カレンダーの予定ドキュメント自体はクライアントが直接Firestoreに書き込む）。
// ============================================================
exports.saveCalendarMetricPhoto = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  const { teamId, storagePath } = request.data || {};
  if (!teamId || !storagePath) throw new HttpsError('invalid-argument', '必要な情報が不足しています');
  const uSnap = await db.collection('users').doc(uid).get();
  const u = uSnap.data();
  if (!u || u.teamId !== teamId) throw new HttpsError('permission-denied', 'このチームのメンバーではありません');
  // 本人のフォルダ（teams/{teamId}/athleteMetrics/{uid}/...）以外への書き込みは許可しない
  if (!storagePath.startsWith(`teams/${teamId}/athleteMetrics/${uid}/`)) {
    throw new HttpsError('permission-denied', '自分のデータ以外は保存できません');
  }

  const bucket = storage.bucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', 'アップロードされた写真が見つかりません');
  const [metadata] = await file.getMetadata();
  const fileSizeBytes = Number(metadata.size) || 0;

  const teamSnap = await db.collection('teams').doc(teamId).get();
  const plan = myNotePlanOf(teamSnap.data());
  const { ref: usageRef } = await getOrInitMyNoteUsage(teamId);

  try {
    await db.runTransaction(async (tx) => {
      const usageSnap = await tx.get(usageRef);
      const usage = usageSnap.data();
      const remaining = plan.storageCapBytes - usage.usedBytes;
      if (remaining < fileSizeBytes) {
        throw new HttpsError('resource-exhausted',
          `保存容量が残り${(remaining / GB).toFixed(2)}GBのため保存できません（この写真は${(fileSizeBytes / GB).toFixed(2)}GB）`);
      }
      tx.update(usageRef, {
        usedBytes: usage.usedBytes + fileSizeBytes,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    await file.delete().catch(() => {});
    throw e;
  }

  const [url] = await file.getSignedUrl({ action: 'read', expires: '2100-01-01' });
  return { url, fileSizeBytes };
});

/** トレーニングデータの予定を削除する時に、写真の実体を消して保存容量を正しく戻す */
exports.deleteCalendarMetricPhoto = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  const { teamId, storagePath } = request.data || {};
  if (!teamId || !storagePath) throw new HttpsError('invalid-argument', '必要な情報が不足しています');
  if (!storagePath.startsWith(`teams/${teamId}/athleteMetrics/${uid}/`)) {
    throw new HttpsError('permission-denied', '自分のデータ以外は削除できません');
  }
  const file = storage.bucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) return { ok: true };
  const [metadata] = await file.getMetadata();
  const fileSizeBytes = Number(metadata.size) || 0;
  await file.delete().catch(() => {});
  const { ref: usageRef } = await getOrInitMyNoteUsage(teamId);
  await db.runTransaction(async (tx) => {
    const usageSnap = await tx.get(usageRef);
    const usage = usageSnap.data();
    tx.update(usageRef, { usedBytes: Math.max(0, usage.usedBytes - fileSizeBytes) });
  });
  return { ok: true };
});

// ============================================================
// ⑨ Polar AccessLink API連携（心拍・消費カロリーなどを公式APIから自動取得）
// ------------------------------------------------------------
// 【全体の流れ】
//   1. クライアントが polarBeginAuth を呼ぶ → 一時トークンを発行し、
//      Polarの認可画面URLを返す（クライアントはそこへ遷移する）
//   2. 選手がPolar Flowでログイン・連携を許可すると、Polarが
//      polarOAuthCallback（このURL自体をPolarの管理画面に登録しておく）へ
//      ブラウザをリダイレクトしてくる
//   3. polarOAuthCallbackが認可コードをアクセストークンに交換し、
//      「ユーザー登録」（Polar側の必須手順）まで済ませてから、
//      アクセストークン自体はクライアントに一切渡さず polarTokens/{uid} にだけ保存する
//      （Firestoreルールでこのコレクションはクライアントからの読み書きを禁止しておくこと）
//   4. 選手が「今すぐ同期」を押すと polarSyncNow が呼ばれ、Polar側の
//      「トランザクション方式」（開く→一覧取得→個別取得→確定、の4手順が必須）に従って
//      新しいトレーニングデータを取得し、teams/{teamId}/athleteMetrics に書き込む
// ============================================================
const POLAR_AUTH_BASE  = 'https://flow.polar.com/oauth2/authorization';
const POLAR_TOKEN_URL  = 'https://polarremote.com/v2/oauth2/token';
const POLAR_API_BASE   = 'https://www.polaraccesslink.com/v3';

exports.polarBeginAuth = onCall({ secrets: [POLAR_CLIENT_ID, POLAR_REDIRECT_URI] }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  // なりすまし対策：state(ワンタイムトークン)を発行し、コールバック側で
  // 「本当にこのuidが開始したリクエストか」をこのトークン経由でのみ確認する
  const token = db.collection('_tmp').doc().id + db.collection('_tmp').doc().id;
  await db.collection('polarPendingAuth').doc(token).set({
    uid, createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const authUrl = `${POLAR_AUTH_BASE}?response_type=code`
    + `&client_id=${encodeURIComponent(POLAR_CLIENT_ID.value())}`
    + `&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI.value())}`
    + `&scope=accesslink.read_all`
    + `&state=${token}`;
  return { authUrl };
});

exports.polarOAuthCallback = onRequest(
  { secrets: [POLAR_CLIENT_ID, POLAR_CLIENT_SECRET, POLAR_REDIRECT_URI] },
  async (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    const htmlPage = (message) => res.status(200).send(`<!DOCTYPE html><html lang="ja"><meta charset="utf-8">
      <body style="font-family:sans-serif;background:#000;color:#fff;display:flex;align-items:center;
        justify-content:center;height:100vh;margin:0;text-align:center;padding:24px;box-sizing:border-box;">
        <div>${message}<br><br>このタブを閉じて、アプリに戻ってください。</div>
      </body></html>`);
    if (!code || !state) return htmlPage('連携に失敗しました（コードが見つかりません）。');
    try {
      const pendingRef = db.collection('polarPendingAuth').doc(String(state));
      const pendingSnap = await pendingRef.get();
      if (!pendingSnap.exists) return htmlPage('連携用のリンクの有効期限が切れています。もう一度お試しください。');
      const { uid } = pendingSnap.data();
      await pendingRef.delete();

      const basicAuth = Buffer.from(`${POLAR_CLIENT_ID.value()}:${POLAR_CLIENT_SECRET.value()}`).toString('base64');
      const tokenRes = await fetch(POLAR_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI.value())}`,
      });
      if (!tokenRes.ok) return htmlPage('Polarとの連携に失敗しました（トークン取得エラー）。');
      const tokenJson = await tokenRes.json();
      const accessToken = tokenJson.access_token;
      const polarUserId = tokenJson.x_user_id;

      // Polar側の必須手順：ユーザー登録（既に登録済み＝409は無視してよい）
      await fetch(`${POLAR_API_BASE}/users`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'member-id': uid }),
      }).catch(() => {});

      // アクセストークンはクライアントへ一切渡さず、Cloud Functionからしか読めない場所に保存する
      await db.collection('polarTokens').doc(uid).set({
        accessToken, polarUserId,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return htmlPage('✅ Polarとの連携が完了しました。');
    } catch (e) {
      console.error('[polar] oauth callback error:', e);
      return htmlPage('連携中にエラーが発生しました。時間をおいて再度お試しください。');
    }
  }
);

exports.polarConnectionStatus = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  const targetUid = (request.data && request.data.athleteUid) || uid;
  if (targetUid !== uid) {
    // 本人以外の状態を見る＝監督・マネージャー・スタッフが選手の連携状況を「閲覧」する場合のみ許可
    const uSnap = await db.collection('users').doc(uid).get();
    const u = uSnap.data();
    const targetSnap = await db.collection('users').doc(targetUid).get();
    const target = targetSnap.data();
    if (!u || u.role !== 'coach' || !target || u.teamId !== target.teamId) {
      throw new HttpsError('permission-denied', 'この選手の情報は閲覧できません');
    }
  }
  const snap = await db.collection('polarTokens').doc(targetUid).get();
  return { connected: snap.exists };
});

exports.polarDisconnect = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  await db.collection('polarTokens').doc(uid).delete().catch(() => {});
  return { ok: true };
});

/** Polarの「心拍」フィールド（zone別）から、平均・最大心拍を取り出す。
 *  AccessLinkの運動サマリーはスポーツやデバイスによって細かい形が違うことがあるため、
 *  無い項目は単純にスキップする（無理に0を入れない）。 */
function extractPolarMetrics(exercise) {
  const metrics = [];
  if (exercise['heart-rate']) {
    if (typeof exercise['heart-rate'].average === 'number') metrics.push({ label: '平均心拍', value: exercise['heart-rate'].average });
    if (typeof exercise['heart-rate'].maximum === 'number') metrics.push({ label: '最大心拍', value: exercise['heart-rate'].maximum });
  }
  if (typeof exercise.calories === 'number') metrics.push({ label: '消費カロリー', value: exercise.calories });
  if (typeof exercise.distance === 'number' && exercise.distance > 0) metrics.push({ label: '距離(m)', value: Math.round(exercise.distance) });
  return metrics;
}

exports.polarSyncNow = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');
  const targetUid = (request.data && request.data.athleteUid) || uid;
  if (targetUid !== uid) {
    // 監督・マネージャー・スタッフが「同じチームの選手」の同期を代わりに実行することだけを許可する。
    // 連携（polarBeginAuth）・解除（polarDisconnect）は選手本人にしかできない（このチェックは無い）。
    const uSnap = await db.collection('users').doc(uid).get();
    const u = uSnap.data();
    const targetSnap = await db.collection('users').doc(targetUid).get();
    const target = targetSnap.data();
    if (!u || u.role !== 'coach' || !target || u.teamId !== target.teamId) {
      throw new HttpsError('permission-denied', 'この選手のデータは同期できません');
    }
  }
  const tokenSnap = await db.collection('polarTokens').doc(targetUid).get();
  if (!tokenSnap.exists) throw new HttpsError('failed-precondition', 'Polarと連携されていません');
  const { accessToken, polarUserId } = tokenSnap.data();
  const uSnapForTeam = await db.collection('users').doc(targetUid).get();
  const teamId = uSnapForTeam.exists && uSnapForTeam.data().teamId;
  if (!teamId) throw new HttpsError('failed-precondition', 'チームに所属していません');

  const authHeader = { 'Authorization': `Bearer ${accessToken}` };

  // ① トランザクションを開く（新しいデータが無ければ204 No Contentが返る＝正常な「無し」）
  const openRes = await fetch(`${POLAR_API_BASE}/users/${polarUserId}/exercise-transactions`, {
    method: 'POST', headers: authHeader,
  });
  if (openRes.status === 204) return { synced: 0 };
  if (!openRes.ok) throw new HttpsError('internal', 'Polarからのデータ取得に失敗しました（トランザクション開始）');
  const openJson = await openRes.json();
  const transactionId = openJson['transaction-id'];

  // ② トランザクション内の運動一覧を取得
  const listRes = await fetch(`${POLAR_API_BASE}/users/${polarUserId}/exercise-transactions/${transactionId}`, {
    headers: authHeader,
  });
  const listJson = await listRes.json();
  const exerciseUrls = listJson['exercises'] || [];

  // ③ 個々の運動データを取得し、心拍・カロリーなどをteams/{teamId}/athleteMetricsへ保存
  let synced = 0;
  for (const url of exerciseUrls) {
    try {
      const exRes = await fetch(url, { headers: authHeader });
      if (!exRes.ok) continue;
      const exercise = await exRes.json();
      const metrics = extractPolarMetrics(exercise);
      if (!metrics.length) continue;
      const dateStr = (exercise['start-time'] || '').slice(0, 10);
      await db.collection('athleteMetricsData').doc(teamId).collection('athletes').doc(targetUid).collection('entries').add({
        title: `Polar：${exercise.sport || 'トレーニング'}`,
        date: dateStr || null,
        allDay: true,
        metrics,
        source: 'polar',
        createdBy: targetUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      synced++;
    } catch (e) { console.warn('[polar] exercise fetch error:', e); }
  }

  // ④ トランザクションを確定（これをしないと同じデータが次回もまた取得されてしまう）
  await fetch(`${POLAR_API_BASE}/users/${polarUserId}/exercise-transactions/${transactionId}`, {
    method: 'PUT', headers: authHeader,
  }).catch(() => {});

  return { synced };
});

// ============================================================
// ⑦ 標準記録：管理者権限の付与
//    ログイン画面の「招待コード」欄は、①実在するチームIDならチーム参加、
//    ②合言葉と一致すれば管理者権限付与、の二役をこなす（見た目は1つの欄のまま）。
//    合言葉の一致判定は必ずここ（サーバー側）だけで行い、クライアントの
//    index.htmlには合言葉そのものを一切書かない。判定結果はadminUsers/{uid}
//    に保存し、firestore.rulesはこのドキュメントを見てstandardRecordsへの
//    書き込みを許可するかどうかを判定する（adminUsers自体はCloud Function
//    専用で、ユーザーからは書き込めない）。
// ============================================================
exports.claimStdRecordAdmin = onCall({ secrets: [STD_RECORD_ADMIN_CODE] }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');

  const code = (request.data && request.data.code || '').trim();
  if (code !== STD_RECORD_ADMIN_CODE.value()) {
    // 合言葉が違う＝普通の招待コードの可能性があるだけなので、ここでは
    // 何も変更せず、ただ「一致しなかった」とだけ返す（エラーにはしない。
    // 呼び出し側は「静かに無視」するので、通常ログインの体験を壊さない）。
    throw new HttpsError('permission-denied', 'コードが一致しません');
  }

  await db.collection('adminUsers').doc(uid).set({
    isStdRecordAdmin: true,
    grantedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { ok: true };
});
// ============================================================
// ⑧【今回追加】AI-OCR中継：スタートリスト（PDF/写真）読み取りで使う。
//    ブラウザから直接Anthropic APIを呼ぶとCORSでブロックされる（本番＝GitHub Pages上で
//    動かない）ため、ここを経由して中継する。index.html側の_callClaudeApi()から呼ばれ、
//    返り値はAnthropic APIのレスポンスをそのまま返す（{content:[...]}の形）ので、
//    呼び出し側の後処理（Claudeの返答パース）はそのまま使い回せる。
//    APIキーはSecret Managerで管理する（ファイル冒頭のANTHROPIC_API_KEY定義を参照。
//    デプロイ前に一度だけ `firebase functions:secrets:set ANTHROPIC_API_KEY` が必要）。
//    悪用（無関係な用途への流用・高額請求）を防ぐ最低限のガードとして、
//    ①ログイン必須（誰でも無制限に呼べないようにする）、②モデル名をホワイトリストで
//    制限、③max_tokensに上限、の3点を設けている。
// ============================================================
const ANTHROPIC_ALLOWED_MODELS = ['claude-sonnet-4-6'];
const ANTHROPIC_MAX_TOKENS_CAP = 16000;

exports.callAnthropic = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'ログインが必要です');

  const { model, max_tokens, messages } = request.data || {};
  if (!model || !Array.isArray(messages) || !messages.length) {
    throw new HttpsError('invalid-argument', '必要な情報が不足しています');
  }
  if (!ANTHROPIC_ALLOWED_MODELS.includes(model)) {
    throw new HttpsError('invalid-argument', '許可されていないモデルです');
  }
  const cappedMaxTokens = Math.min(Number(max_tokens) || 4096, ANTHROPIC_MAX_TOKENS_CAP);

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY.value(),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: cappedMaxTokens, messages }),
    });
  } catch (e) {
    console.error('[callAnthropic] fetch error:', e);
    throw new HttpsError('unavailable', 'Anthropic APIへの接続に失敗しました');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('[callAnthropic] Anthropic API error:', response.status, data);
    const msg = (data && data.error && data.error.message) || `Anthropic APIエラー（${response.status}）`;
    throw new HttpsError('internal', msg);
  }
  return data;
});
