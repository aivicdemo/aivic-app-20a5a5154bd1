// AIVIC Backend Configuration
// AIVIC_APP_URL 環境変数が設定されている場合は自動セットされます
// 未設定の場合: REPLACE_WITH_API_URL を AIVIC アプリの URL（例: https://your-app.amplifyapp.com）に書き換えてください

window.AIVIC_API_URL = "REPLACE_WITH_API_URL";
window.AIVIC_TABLES = {
  "ユーザー管理テーブル": 0,
  "ファイルアップロード管理テーブル": 1,
  "翻訳進捗管理テーブル": 2,
  "ファイル形式定義テーブル": 3,
  "翻訳エンジン設定テーブル": 4,
  "翻訳履歴テーブル": 5,
  "エラーログテーブル": 6,
  "システム設定テーブル": 7,
  "翻訳品質評価テーブル": 8
};
