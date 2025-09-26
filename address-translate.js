/** ===== 설정: 승인키/레이트 ===== */
const KEYS = {
  kor: 'U01TX0FVVEgyMDI1MDkyNjE3MjYwMzExNjI3MTg=',
  eng: 'U01TX0FVVEgyMDI1MDkyNjE3MzIwNDExNjI3MjE='
};
const RATE = { minIntervalMs: 90, concurrency: 3 };

/** ===== JSONP 유틸 (CORS 회피) ===== */
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

/** ===== 요청 큐 (동시 3건 + 최소간격 90ms) ===== */
class RequestQueue{
  constructor({concurrency, minIntervalMs}){
    this.concurrency = concurrency;
    this.minIntervalMs = minIntervalMs;
    this.running = 0; this.queue = []; this.lastAt = 0;
  }
  push(task){
    return new Promise((resolve,reject)=>{
      this.queue.push({task, resolve, reject}); this._next();
    });
  }
  _next(){
    if(this.running >= this.concurrency) return;
    const item = this.queue.shift(); if(!item) return;
    const now = Date.now(), wait = Math.max(0, this.minIntervalMs - (now - this.lastAt));
    this.running++;
    setTimeout(async ()=>{
      try{ item.resolve(await item.task()); }
      catch(e){ item.reject(e); }
      finally{ this.lastAt = Date.now(); this.running--; this._next(); }
    }, wait);
  }
}
const rq = new RequestQueue(RATE);

/** ===== 공통 도우미 ===== */
function esc(s){ return String(s??'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m])); }
function toCSV(rows){
  return rows.map(r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
}
function download(name, text){
  // UTF-8 BOM 추가로 한글 깨짐 방지
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + text], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
function zipStr(v){ return String(v??'').trim().padStart(5,'0').slice(-5); }
function clean(t){ return String(t||'').replace(/\s+/g,' ').trim(); }

/** ===== API 래퍼 ===== */
const API = {
  engSearch: (kw,{page=1,per=7}={}) =>
    rq.push(()=>jsonp('https://business.juso.go.kr/addrlink/addrEngApiJsonp.do', {
      confmKey: KEYS.eng, currentPage: page, countPerPage: per, keyword: kw, resultType:'json'
    })),
  korSearch: (kw,{page=1,per=5}={}) =>
    rq.push(()=>jsonp('https://business.juso.go.kr/addrlink/addrLinkApiJsonp.do', {
      confmKey: KEYS.kor, currentPage: page, countPerPage: per, keyword: kw, resultType:'json'
    })),
  detail: ({admCd,rnMgtSn,udrtYn,buldMnnm,buldSlno}) =>
    rq.push(()=>jsonp('https://business.juso.go.kr/addrlink/addrDetailApiJsonp.do', {
      confmKey: KEYS.kor, admCd, rnMgtSn, udrtYn, buldMnnm, buldSlno, resultType:'json'
    }))
};

/** ===== 스코어/정렬 ===== */
function scoreCandidate(c, hint){
  let s = 0;
  if(c.source==='detail') s += 100;     // detail 성공 최우선
  if(c.zipNo) s += 3;
  if(/\d/.test(c.roadAddr||'')) s += 1; // 건물번호 들어있으면 +1
  if(hint && c.roadAddr){
    const h = clean(hint).toLowerCase(), r = clean(c.roadAddr).toLowerCase();
    if(h && r && (r.includes(h.split(',')[0]) || h.includes(r.split(' ')[0]))) s += 2;
  }
  return s;
}

/** ===== 번역 1건 ===== */
async function translateOne(enText){
  const out = { best:null, candidates:[] };

  // 1) 영문 검색
  try {
    const rEn = await API.engSearch(enText);
    console.log('영문 검색 결과:', rEn);
    
    const okEn = rEn?.results?.common?.errorCode==="0";
    const listEn = okEn ? (rEn?.results?.juso||[]) : [];
    
    if(!okEn) {
      console.log('영문 검색 실패:', rEn?.results?.common?.errorMessage);
      return out;
    }
    
    if(listEn.length===0) {
      console.log('영문 검색 결과 없음');
      return out;
    }
    
    console.log('영문 검색 성공, 결과 수:', listEn.length);
  } catch(error) {
    console.error('영문 검색 오류:', error);
    return out;
  }

  // 2) detail 재조회(가능한 후보 모두 시도)
  const rEn = await API.engSearch(enText);
  const listEn = rEn?.results?.juso || [];
  
  for(const it of listEn){
    const {admCd, rnMgtSn, udrtYn, buldMnnm, buldSlno} = it;
    if(admCd && rnMgtSn && buldMnnm!=null){
      try {
        const rD = await API.detail({admCd, rnMgtSn, udrtYn, buldMnnm, buldSlno});
        console.log('상세주소 API 결과:', rD);
        
        if(rD?.results?.common?.errorCode==="0"){
          const j = (rD?.results?.juso||[])[0];
          if(j){
            const cand = {
              roadAddr: j.roadAddr||'',
              jibunAddr: j.jibunAddr||'',
              zipNo: zipStr(j.zipNo||''),
              source:'detail'
            };
            cand.score = scoreCandidate(cand, enText);
            out.candidates.push(cand);
            console.log('상세주소 후보 추가:', cand);
          }
        } else {
          console.log('상세주소 API 실패:', rD?.results?.common?.errorMessage);
        }
      } catch(error) {
        console.error('상세주소 API 오류:', error);
      }
    }
  }

  // 3) detail이 없으면 kor 검색으로 역탐색
  if(out.candidates.length===0){
    console.log('상세주소 결과 없음, 한글 검색으로 역탐색 시작');
    const head = listEn.slice(0,3);
    for(const it of head){
      const kw = clean([
        it.siNm||'', it.sggNm||'', it.emdNm||'',
        it.rn||'', it.buldMnnm||'',
        (it.buldSlno && Number(it.buldSlno)>0? it.buldSlno : '')
      ].join(' '));
      if(!kw) continue;
      
      try {
        console.log('한글 검색 키워드:', kw);
        const rKor = await API.korSearch(kw,{per:5});
        console.log('한글 검색 결과:', rKor);
        
        if(rKor?.results?.common?.errorCode==="0"){
          (rKor?.results?.juso||[]).forEach(j=>{
            const cand = {
              roadAddr: j.roadAddr||'',
              jibunAddr: j.jibunAddr||'',
              zipNo: zipStr(j.zipNo||''),
              source:'korSearch'
            };
            cand.score = scoreCandidate(cand, enText);
            out.candidates.push(cand);
            console.log('한글 검색 후보 추가:', cand);
          });
        } else {
          console.log('한글 검색 실패:', rKor?.results?.common?.errorMessage);
        }
      } catch(error) {
        console.error('한글 검색 오류:', error);
      }
    }
  }

  // 4) 중복 제거 + 정렬 + 베스트 선택
  console.log('전체 후보 수:', out.candidates.length);
  const seen = new Set(), uniq = [];
  for(const c of out.candidates){
    const k = (c.roadAddr||'')+'|'+(c.zipNo||'');
    if(!seen.has(k)){ seen.add(k); uniq.push(c); }
  }
  uniq.sort((a,b)=>(b.score||0)-(a.score||0));
  out.candidates = uniq;
  out.best = uniq[0]||null;
  
  console.log('최종 후보 수:', uniq.length);
  console.log('선택된 베스트:', out.best);
  
  return out;
}

/** ===== UI 바인딩 ===== */
const $eng = document.getElementById('engInput');
const $tbody = document.getElementById('tbody');
const $st = document.getElementById('st');
const $btn = document.getElementById('btnRun');
const $csv = document.getElementById('btnCsv');

$btn.addEventListener('click', async ()=>{
  const lines = $eng.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  $tbody.innerHTML=''; $st.textContent='';
  if(lines.length===0) {
    $st.textContent = '입력된 영문 주소가 없습니다.';
    $st.className = 'status warn';
    return;
  }

  // 버튼 비활성화
  $btn.disabled = true;
  $btn.textContent = '처리 중...';

  let ok=0,warn=0,err=0;
  const csvRows = [['번호','영문주소','한글주소','우편번호','선택','비고']];

  const jobs = lines.map((line, i)=> (async ()=>{
    try{
      console.log(`처리 시작: ${i+1}번째 주소 - ${line}`);
      const r = await translateOne(line);
      console.log(`처리 완료: ${i+1}번째 주소 결과:`, r);
      
      if(!r.best){
        console.log(`매칭 실패: ${i+1}번째 주소`);
        err++; appendRow(i+1, line, [], null, '매칭없음');
        csvRows.push([i+1, line, '', '', '', 'NO_MATCH']);
        return;
      }
      const note = r.candidates.length>1 ? `다중매칭 ${r.candidates.length}건` : '';
      ok++; if(note) warn++;
      appendRow(i+1, line, r.candidates, r.best, note);
      csvRows.push([i+1, line, r.best.roadAddr||'', r.best.zipNo||'', 'auto', note]);
    }catch(e){
      console.error(`처리 오류: ${i+1}번째 주소`, e); 
      err++; appendRow(i+1, line, [], null, '에러');
      csvRows.push([i+1, line, '', '', '', 'ERROR']);
    }
  })());

  await Promise.all(jobs);
  $st.textContent = `완료: ${ok} · 주의: ${warn} · 실패: ${err}`;
  $st.className = 'status ' + (err? 'err' : warn? 'warn' : 'ok');
  $csv.onclick = ()=> download(`address-translate-${Date.now()}.csv`, toCSV(csvRows));
  
  // 버튼 복원
  $btn.disabled = false;
  $btn.textContent = '영→한 번역';
});

function appendRow(i, inputEn, candidates, best, note){
  const tr = document.createElement('tr');
  const zip = best? best.zipNo : '-';
  const addr = best? (best.roadAddr||best.jibunAddr||'-') : '-';

  const addrEl = document.createElement('td'); addrEl.innerHTML = esc(addr);
  const zipEl  = document.createElement('td'); zipEl.innerHTML  = `<strong>${esc(zip)}</strong>`;

  const sel = document.createElement('select');
  sel.innerHTML = `<option value="-1">(다른 후보 선택)</option>` +
    candidates.map((c,idx)=>`<option value="${idx}">${esc((c.roadAddr||c.jibunAddr||'').slice(0,64))} · ${c.zipNo}</option>`).join('');
  sel.addEventListener('change', e=>{
    const idx = Number(e.target.value);
    if(idx>=0){
      const c = candidates[idx];
      addrEl.innerHTML = esc(c.roadAddr||c.jibunAddr||'-');
      zipEl.textContent = c.zipNo || '';
    }
  });

  tr.innerHTML = `<td>${i}</td><td>${esc(inputEn)}</td>`;
  tr.appendChild(addrEl);
  tr.appendChild(zipEl);
  const tdSel = document.createElement('td'); tdSel.appendChild(sel); tr.appendChild(tdSel);
  $tbody.appendChild(tr);

  if(note){
    const noteRow = document.createElement('tr');
    noteRow.innerHTML = `<td></td><td colspan="4" class="mono" style="color:#AFC3DA">참고: ${esc(note)}</td>`;
    $tbody.appendChild(noteRow);
  }
}
