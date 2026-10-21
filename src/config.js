// Supabase 연결 정보.
// 새로 설치한 jple은 처음 켤 때 "연결 코드 넣기", "새 DB 만들기", "이 PC를 서버로 시작"으로 연결할 DB를 정해요.
// 그래서 여기에는 기본 연결을 넣지 않아요.
// Publishable key(공개 키)는 공개되어도 괜찮은 키예요. 보안은 데이터베이스 권한(RLS)이 맡아요.
// Secret key나 service_role 키는 절대 여기에 넣지 마세요.
module.exports = {
  // 연결 코드 방식 전(0.3.0 전)에 설치해서 쓰던 PC가 끊기지 않도록 이어 줄 연결.
  // 공개 저장소에는 특정 학교의 DB 주소를 넣지 않아요. 필요하면 학교별 빌드에서만 { url, key }를 넣어요.
  legacy: null,
  // 아이디를 로그인용 이메일로 바꿀 때 쓰는 도메인. supabase/functions/admin-users/index.ts와 같아야 해요.
  emailDomain: 'example.com',
}
