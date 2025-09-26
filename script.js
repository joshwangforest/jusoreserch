/** =========================
 *  설정 (승인키 내장 / 호출 최적화)
 *  ========================= */
const CONF_KEYS = {
  kor: 'U01TX0FVVEgyMDI1MDkyNjE3MjYwMzExNjI3MTg=',
  eng: 'U01TX0FVVEgyMDI1MDkyNjE3MzIwNDExNjI3MjE='
};
// 호출 간격/동시성: 다중 매칭 정확도를 위한 최적화 (API 제한 고려)
const RATE = { minIntervalMs: 150, concurrency: 2 };

/** =========================
 *  JSONP 유틸 (CORS 회피)
 *  ========================= */
function jsonp(url, params){
  return new Promise((resolve, reject)=>{
    const cb = 'cb_'+Math.random().toString(36).slice(2);
    const q = new URLSearchParams({...params, callback:cb});
    const s = document.createElement('script');
    s.src = url + (url.includes('?')?'&':'?') + q.toString();
    s.onerror = ()=>{ cleanup(); reject(new Error('JSONP 네트워크 오류')); };
    
    // 타임아웃 설정 (30초)
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP 요청 타임아웃'));
    }, 30000);
    
    window[cb] = (data)=>{ 
      clearTimeout(timeout);
      cleanup(); 
      resolve(data); 
    };
    
    function cleanup(){ 
      clearTimeout(timeout);
      delete window[cb]; 
      if(s.parentNode) s.remove(); 
    }
    document.head.appendChild(s);
  });
}

/** =========================
 *  요청 큐 (동시성 + 최소 간격)
 *  ========================= */
class RequestQueue{
  constructor({concurrency, minIntervalMs}){
    this.concurrency = concurrency;
    this.minIntervalMs = minIntervalMs;
    this.running = 0;
    this.queue = [];
    this.lastAt = 0;
  }
  push(task){ // task: () => Promise<any>
    return new Promise((resolve,reject)=>{
      this.queue.push({task, resolve, reject});
      this._next();
    });
  }
  async _next(){
    if(this.running >= this.concurrency) return;
    const item = this.queue.shift();
    if(!item) return;
    const now = Date.now();
    const diff = now - this.lastAt;
    const wait = Math.max(0, this.minIntervalMs - diff);
    this.running++;
    setTimeout(async ()=>{
      try{
        const res = await item.task();
        item.resolve(res);
      }catch(e){ item.reject(e); }
      finally{
        this.lastAt = Date.now();
        this.running--;
        this._next();
      }
    }, wait);
  }
}
const rq = new RequestQueue(RATE);

/** =========================
 *  공통 도우미
 *  ========================= */
function esc(s){ return String(s??'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m])); }
function toCSV(rows){
  return rows.map(r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
}
function download(name, text){
  const blob = new Blob([text], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
// 우편번호는 항상 문자열 5자리 (앞 0 보존)
function zipStr(v){
  const s = (v==null?'':String(v).trim());
  return s.padStart(5, '0').slice(-5);
}

/** =========================
 *  점수 기반 매칭 (다중매칭 중 최선 자동 선택)
 *  ========================= */
function scoreJuso(item, keyword){
  let score = 0;
  const k = keyword.replace(/\s+/g,'').toLowerCase();
  const road = (item.roadAddr||'').replace(/\s+/g,'').toLowerCase();
  const jibun = (item.jibunAddr||'').replace(/\s+/g,'').toLowerCase();
  
  // 도로명주소 매칭 (가장 높은 점수)
  if(road && k.includes(road)) score += 8;
  if(jibun && k.includes(jibun)) score += 6;
  
  // 부분 매칭 점수
  const roadParts = road.split(/\d+/).filter(p => p.length > 1);
  const jibunParts = jibun.split(/\d+/).filter(p => p.length > 1);
  
  roadParts.forEach(part => {
    if(k.includes(part)) score += 2;
  });
  jibunParts.forEach(part => {
    if(k.includes(part)) score += 1;
  });
  
  // 번호 일치 가산 (건물 본번/부번, 우편번호)
  if(item.zipNo) score += 3;
  if(item.buldMnnm) score += 2;
  if(item.buldSlno && Number(item.buldSlno)>0) score += 1;
  
  return score;
}

/** =========================
 *  API 호출 래퍼
 *  ========================= */
function callKorSearch(keyword, {page=1, per=5}={}){
  return rq.push(()=>jsonp('https://business.juso.go.kr/addrlink/addrLinkApiJsonp.do', {
    confmKey: CONF_KEYS.kor, 
    currentPage: page, 
    countPerPage: per, 
    keyword: keyword.trim(), 
    resultType:'json'
  }));
}
function callEngSearch(keyword, {page=1, per=5}={}){
  return rq.push(()=>jsonp('https://business.juso.go.kr/addrlink/addrEngApiJsonp.do', {
    confmKey: CONF_KEYS.eng, 
    currentPage: page, 
    countPerPage: per, 
    keyword: keyword.trim(), 
    resultType:'json'
  }));
}

/** =========================
 *  ① 대량 주소 → 우편번호
 *  ========================= */
const bulkInput = document.getElementById('bulkInput');
const bulkTbody = document.getElementById('bulkTbody');
const bulkStatus = document.getElementById('bulkStatus');
const btnBulk = document.getElementById('btnBulk');
const btnBulkCsv = document.getElementById('btnBulkCsv');

btnBulk.addEventListener('click', async ()=>{
  const lines = bulkInput.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  bulkTbody.innerHTML = ''; bulkStatus.textContent = '';
  if(lines.length===0) {
    bulkStatus.textContent = '입력된 주소가 없습니다.';
    bulkStatus.className = 'status warn';
    return;
  }
  
  // 버튼 비활성화
  btnBulk.disabled = true;
  btnBulk.textContent = '처리 중...';

  let ok=0,warn=0,err=0;
  const csvRows = [['index','input','matched_addr','zipNo','choice','note']];

  const tasks = lines.map((keyword, idx)=> (async ()=>{
    try{
      const res = await callKorSearch(keyword, {per:10});
      const code = res?.results?.common?.errorCode;
      if(code!=="0") throw new Error(res?.results?.common?.errorMessage||'API 오류');
      const list = res?.results?.juso || [];
      if(list.length===0){
        err++; appendBulkRow(idx+1, keyword, [], null, '매칭없음');
        csvRows.push([idx+1, keyword, '', '', '', 'NO_MATCH']);
        return;
      }
      // 점수로 정렬
      list.sort((a,b)=> scoreJuso(b,keyword)-scoreJuso(a,keyword));
      const best = list[0];
      const note = list.length>1 ? `다중매칭 ${list.length}건` : '';
      ok++; if(note) warn++;
      appendBulkRow(idx+1, keyword, list, best, note);
      csvRows.push([idx+1, keyword, best.roadAddr||best.jibunAddr||'', zipStr(best.zipNo||''), 'auto', note]);
    }catch(e){
      console.error(e); err++;
      appendBulkRow(idx+1, keyword, [], null, '에러');
      csvRows.push([idx+1, keyword, '', '', '', 'ERROR']);
    }
  })());

  await Promise.all(tasks);
  bulkStatus.textContent = `완료: ${ok} · 주의: ${warn} · 실패: ${err}`;
  bulkStatus.className = 'status ' + (err? 'err' : warn? 'warn' : 'ok');
  btnBulkCsv.onclick = ()=> download(`postcode-results-${Date.now()}.csv`, toCSV(csvRows));
  
  // 버튼 복원
  btnBulk.disabled = false;
  btnBulk.textContent = '우편번호 추출';
});

function appendBulkRow(i, input, candidates, best, note){
  const tr = document.createElement('tr');
  const zip = best? zipStr(best.zipNo||'') : '-';
  const addr = best? (best.roadAddr||best.jibunAddr||'-') : '-';
  const sel = document.createElement('select');
  sel.innerHTML = `<option value="-1">(다른 매칭 선택)</option>` +
    candidates.map((c,idx)=>`<option value="${idx}">${esc((c.roadAddr||c.jibunAddr||'').slice(0,60))} · ${zipStr(c.zipNo||'')}</option>`).join('');
  sel.addEventListener('change', e=>{
    const idx = Number(e.target.value);
    if(idx>=0){
      const c = candidates[idx];
      addrEl.innerHTML = esc(c.roadAddr||c.jibunAddr||'-');
      zipEl.textContent = zipStr(c.zipNo||'');
    }
  });

  const addrEl = document.createElement('td'); addrEl.innerHTML = esc(addr);
  const zipEl = document.createElement('td'); zipEl.innerHTML = `<strong>${esc(zip)}</strong>`;

  tr.innerHTML = `<td>${i}</td><td>${esc(input)}</td>`;
  tr.appendChild(addrEl);
  tr.appendChild(zipEl);
  const tdSel = document.createElement('td'); tdSel.appendChild(sel); tr.appendChild(tdSel);
  bulkTbody.appendChild(tr);

  if(note){
    const noteRow = document.createElement('tr');
    noteRow.innerHTML = `<td></td><td colspan="4" class="mono" style="color:#AFC3DA">참고: ${esc(note)}</td>`;
    bulkTbody.appendChild(noteRow);
  }
}

/** =========================
 *  ② 영문 → 한글 변환 (정확도 보강)
 *  - 1단계: 영문 API로 후보 수집
 *  - 2단계: 행정구역/도로/건물번호로 한글 검색 재조회 → 최선 매칭
 *  ========================= */
const engInput = document.getElementById('engInput');
const engTbody = document.getElementById('engTbody');
const engStatus = document.getElementById('engStatus');
const btnEng = document.getElementById('btnEng');
const btnEngCsv = document.getElementById('btnEngCsv');

btnEng.addEventListener('click', async ()=>{
  const lines = engInput.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  engTbody.innerHTML = ''; engStatus.textContent = '';
  if(lines.length===0) {
    engStatus.textContent = '입력된 영문 주소가 없습니다.';
    engStatus.className = 'status warn';
    return;
  }
  
  // 버튼 비활성화
  btnEng.disabled = true;
  btnEng.textContent = '처리 중...';

  let ok=0,warn=0,err=0;
  const csvRows = [['index','input_en','kor_addr','zipNo','choice','note']];

  const tasks = lines.map((en, idx)=> (async ()=>{
    try{
      const resEn = await callEngSearch(en, {per:10});
      const code = resEn?.results?.common?.errorCode;
      if(code!=="0") throw new Error(resEn?.results?.common?.errorMessage||'영문 API 오류');
      const listEn = resEn?.results?.juso || [];
      if(listEn.length===0){
        err++; appendEngRow(idx+1, en, [], null, '매칭없음');
        csvRows.push([idx+1, en, '', '', '', 'NO_MATCH']);
        return;
      }
      // 영문 결과 각 항목을 한글 검색으로 역매칭
      const korCandidates = [];
      for(const it of listEn){
        const kw = [
          it.siNm||'', it.sggNm||'', it.emdNm||'',
          it.rn||'', it.buldMnnm||'', (it.buldSlno && Number(it.buldSlno)>0? it.buldSlno : '')
        ].join(' ').replace(/\s+/g,' ').trim();
        if(!kw) continue;
        try{
          const resKor = await callKorSearch(kw, {per:5});
          if(resKor?.results?.common?.errorCode==="0"){
            (resKor?.results?.juso||[]).forEach(j=> korCandidates.push(j));
          }
        }catch(_){} // 개별 실패는 무시하고 다음 후보로
      }
      if(korCandidates.length===0){
        // 영문 API의 roadAddr(영문)만 있는 경우: zipNo라도 가져와 표기
        const fallback = listEn[0];
        warn++;
        appendEngRow(idx+1, en, [], { roadAddr: '(한글주소 추정 실패)', zipNo: fallback.zipNo||'' }, '역매칭 실패 · 영문 zip 사용');
        csvRows.push([idx+1, en, '', zipStr(fallback.zipNo||''), 'auto', 'FALLBACK_ZIP_ONLY']);
        return;
      }
      // 중복 제거(roadAddr 기준)
      const map = new Map();
      for(const j of korCandidates){
        const key = (j.roadAddr||j.jibunAddr||'') + '|' + (j.zipNo||'');
        if(!map.has(key)) map.set(key, j);
      }
      const uniq = Array.from(map.values());
      // 원본 영문 텍스트와의 유사도 + zip 가중
      uniq.sort((a,b)=>{
        const sa = scoreJuso(a, en) + (a.zipNo? 1:0);
        const sb = scoreJuso(b, en) + (b.zipNo? 1:0);
        return sb - sa;
      });
      const best = uniq[0];
      const note = uniq.length>1 ? `다중매칭 ${uniq.length}건` : '';
      ok++; if(note) warn++;
      appendEngRow(idx+1, en, uniq, best, note);
      csvRows.push([idx+1, en, best.roadAddr||best.jibunAddr||'', zipStr(best.zipNo||''), 'auto', note]);
    }catch(e){
      console.error(e); err++;
      appendEngRow(idx+1, en, [], null, '에러');
      csvRows.push([idx+1, en, '', '', '', 'ERROR']);
    }
  })());

  await Promise.all(tasks);
  engStatus.textContent = `완료: ${ok} · 주의: ${warn} · 실패: ${err}`;
  engStatus.className = 'status ' + (err? 'err' : warn? 'warn' : 'ok');
  btnEngCsv.onclick = ()=> download(`eng2kor-results-${Date.now()}.csv`, toCSV(csvRows));
  
  // 버튼 복원
  btnEng.disabled = false;
  btnEng.textContent = '영→한 변환';
});

function appendEngRow(i, inputEn, candidates, best, note){
  const tr = document.createElement('tr');
  const zip = best? zipStr(best.zipNo||'') : '-';
  const addr = best? (best.roadAddr||best.jibunAddr||'-') : '-';
  const sel = document.createElement('select');
  sel.innerHTML = `<option value="-1">(다른 매칭 선택)</option>` +
    candidates.map((c,idx)=>`<option value="${idx}">${esc((c.roadAddr||c.jibunAddr||'').slice(0,60))} · ${zipStr(c.zipNo||'')}</option>`).join('');
  const addrEl = document.createElement('td'); addrEl.innerHTML = esc(addr);
  const zipEl = document.createElement('td'); zipEl.innerHTML = `<strong>${esc(zip)}</strong>`;
  sel.addEventListener('change', e=>{
    const idx = Number(e.target.value);
    if(idx>=0){
      const c = candidates[idx];
      addrEl.innerHTML = esc(c.roadAddr||c.jibunAddr||'-');
      zipEl.textContent = zipStr(c.zipNo||'');
    }
  });

  tr.innerHTML = `<td>${i}</td><td>${esc(inputEn)}</td>`;
  tr.appendChild(addrEl);
  tr.appendChild(zipEl);
  const tdSel = document.createElement('td'); tdSel.appendChild(sel); tr.appendChild(tdSel);
  engTbody.appendChild(tr);

  if(note){
    const noteRow = document.createElement('tr');
    noteRow.innerHTML = `<td></td><td colspan="4" class="mono" style="color:#AFC3DA">참고: ${esc(note)}</td>`;
    engTbody.appendChild(noteRow);
  }
}
