# API 문서

## 개요

주소 도우미는 우정사업본부의 주소 검색 API를 JSONP 방식으로 호출하여 CORS 문제를 해결합니다.

## 사용 API

### 1. 도로명주소 검색 API

**엔드포인트**: `https://business.juso.go.kr/addrlink/addrLinkApiJsonp.do`

**파라미터**:
- `confmKey`: API 승인키
- `currentPage`: 현재 페이지 (기본값: 1)
- `countPerPage`: 페이지당 결과 수 (기본값: 5)
- `keyword`: 검색 키워드
- `resultType`: 결과 형식 (json)
- `callback`: JSONP 콜백 함수명

**응답 형식**:
```json
{
  "results": {
    "common": {
      "errorCode": "0",
      "errorMessage": "정상"
    },
    "juso": [
      {
        "roadAddr": "서울특별시 강서구 양천로 344",
        "jibunAddr": "서울특별시 강서구 가양동 1495",
        "zipNo": "07590",
        "admCd": "1150010100",
        "rnMgtSn": "115004112003",
        "bdMgtSn": "1150010100101495000000001",
        "detBdNmList": "",
        "bdNm": "",
        "bdKdcd": "1",
        "siNm": "서울특별시",
        "sggNm": "강서구",
        "emdNm": "가양동",
        "rn": "양천로",
        "udrtYn": "0",
        "buldMnnm": "344",
        "buldSlno": "0",
        "mtYn": "0",
        "lnbrMnnm": "1495",
        "lnbrSlno": "0",
        "emdNo": "01"
      }
    ]
  }
}
```

### 2. 영문주소 검색 API

**엔드포인트**: `https://business.juso.go.kr/addrlink/addrEngApiJsonp.do`

**파라미터**:
- `confmKey`: API 승인키
- `currentPage`: 현재 페이지 (기본값: 1)
- `countPerPage`: 페이지당 결과 수 (기본값: 5)
- `keyword`: 검색 키워드 (영문)
- `resultType`: 결과 형식 (json)
- `callback`: JSONP 콜백 함수명

**응답 형식**:
```json
{
  "results": {
    "common": {
      "errorCode": "0",
      "errorMessage": "정상"
    },
    "juso": [
      {
        "roadAddr": "344 Yangcheon-ro, Gangseo-gu, Seoul",
        "zipNo": "07590",
        "admCd": "1150010100",
        "rnMgtSn": "115004112003",
        "bdMgtSn": "1150010100101495000000001",
        "siNm": "Seoul",
        "sggNm": "Gangseo-gu",
        "emdNm": "Gayang-dong",
        "rn": "Yangcheon-ro",
        "buldMnnm": "344",
        "buldSlno": "0"
      }
    ]
  }
}
```

## 에러 코드

| 코드 | 메시지 | 설명 |
|------|--------|------|
| 0 | 정상 | 성공 |
| -999 | 시스템 에러 | 시스템 오류 |
| E001 | 승인되지 않은 키 | 잘못된 API 키 |
| E002 | 잘못된 요청 파라미터 | 필수 파라미터 누락 |
| E003 | 검색 결과가 없습니다 | 검색 결과 없음 |

## 사용 제한

- API 호출 제한: 분당 최대 1000회
- 동시 요청 제한: 최대 3개
- 최소 요청 간격: 90ms

## 보안 고려사항

- API 키는 클라이언트에 노출되므로 프로덕션 환경에서는 서버 사이드 프록시 사용 권장
- JSONP 방식 사용으로 XSS 공격에 취약할 수 있음
- 신뢰할 수 있는 도메인에서만 API 키 사용

## 예제 코드

### JavaScript에서 API 호출

```javascript
// JSONP 함수
function jsonp(url, params) {
  return new Promise((resolve, reject) => {
    const cb = 'cb_' + Math.random().toString(36).slice(2);
    const q = new URLSearchParams({...params, callback: cb});
    const s = document.createElement('script');
    s.src = url + (url.includes('?') ? '&' : '?') + q.toString();
    s.onerror = () => {
      cleanup();
      reject(new Error('JSONP 네트워크 오류'));
    };
    window[cb] = (data) => {
      cleanup();
      resolve(data);
    };
    function cleanup() {
      delete window[cb];
      s.remove();
    }
    document.head.appendChild(s);
  });
}

// API 호출 예제
async function searchAddress(keyword) {
  try {
    const result = await jsonp('https://business.juso.go.kr/addrlink/addrLinkApiJsonp.do', {
      confmKey: 'YOUR_API_KEY',
      currentPage: 1,
      countPerPage: 10,
      keyword: keyword,
      resultType: 'json'
    });
    
    if (result.results.common.errorCode === '0') {
      console.log('검색 결과:', result.results.juso);
    } else {
      console.error('API 오류:', result.results.common.errorMessage);
    }
  } catch (error) {
    console.error('요청 실패:', error);
  }
}
```
