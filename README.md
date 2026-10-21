# jple

제작: tj, hs

학교 교직원이 함께 쓰는 **바탕화면 일정 위젯**이에요(Windows).

- 왼쪽: 시간 | 내 업무 | 학교 전체, 오른쪽: 한 달 달력, 주간업무 표(인쇄·엑셀)
- DB: 외부(Supabase) 또는 학교 안 서버 PC의 로컬 DB(SQLite, 대기 서버 최대 2대, 자동 전환)
- 관리자: 계정·부서 관리, DB 관리(백업·복원·옮기기), 업데이트 배포

자세한 설계와 결정 기록은 [prd.md](prd.md), 처음 인터뷰는 [interview.md](interview.md)에 있어요.

## 개발

```bash
npm install
npm start
```

설치 파일 만들기: `npm run dist` → `dist/jple_설치_버전.exe`

## 제작자

tj, hs
