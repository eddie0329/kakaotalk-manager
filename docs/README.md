# 답장노트 다운로드 페이지

빌드나 패키지 설치가 필요 없는 GitHub Pages용 정적 사이트입니다. 앱 소스와 독립적으로 동작합니다.

## 미리보기

저장소 루트에서 `python3 -m http.server 4173 --directory docs`를 실행하고 http://localhost:4173 에 접속합니다.

## 다운로드 연결

GitHub Releases에 설치 파일을 게시한 다음 `app.js`의 플랫폼별 `url`에 실제 HTTPS 다운로드 주소, `version`에 해당 버전을 입력합니다. 현재 두 플랫폼 모두 v0.4.4 GitHub Release에 연결되어 있습니다. JavaScript가 꺼져도 다운로드할 수 있도록 index.html의 링크와 버전 표시도 함께 갱신해주세요.

## GitHub Pages 게시

이 폴더를 저장소에 푸시한 후 Settings → Pages → Deploy from a branch에서 배포 브랜치와 `/docs`를 선택합니다. 다운로드 전용 공개 저장소를 사용한다면 이 폴더의 내용만 해당 저장소 루트로 복사하고 `/ (root)`를 선택해도 됩니다. `.nojekyll` 파일도 함께 포함해주세요.

앱의 `npm run build`는 이 사이트에 필요하지 않습니다. Mac/Windows 실제 제공 버전에 맞춰 다운로드 설명을 수정해주세요.
