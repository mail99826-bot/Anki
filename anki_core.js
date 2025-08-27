
// ===== anki_core.js (aligned DP, clean) =====
// Предполагается, что ранее загружен _anki_dicts.js,
// который кладёт словари в window.ANKI_DICTS

(function(){
  // ====== CONFIG (ядро) ======
  const CFG = {
    VERSION: "v3.22.0-core-mobileNumsUSUK-compat",
    weights: { A:1.0, B:0.6, C:0.2, SHORT:0.6 },
    penalty: {
      extraPerWord: 0.3,
      extraCapToken: 0.6,
      extraCapPhrase: 0.25,
      orderA: 0.2,
      orderCap: 0.15,
      hintMaxFrac: 0.20,
      hintCurve: { type: "sigmoid", k: 12, x0: 0.45 }
    },
    // Порог совпадения A-токена, чтобы учитывать его в штрафе за порядок
    orderMatchMin: 0.8,
    hysteresis: { hard: 68, again: 72 },
    auxCritical: { mode: "contextual" } // "all" | "contextual" | "off"
  };

  // ====== Загрузка словарей из window.ANKI_DICTS ======
  const D = (typeof window!=="undefined" && window.ANKI_DICTS) ? window.ANKI_DICTS : null;
  if(!D){
    console.warn("[anki_core] Не найден window.ANKI_DICTS. Инициализирую пустыми наборами.");
  }

  // базовые наборы
  CFG.shortSet   = new Set(D?.shortSet   || []);
  CFG.criticalA  = new Set(D?.criticalA  || []);
  CFG.temporalA  = new Set(D?.temporalA  || []);

  // многословные фразы B/C (сырые строки) → сет с подчёркиваниями
  const PHRASES_B_RAW = D?.phrasesB || [];
  const PHRASES_C_RAW = D?.phrasesC || [];
  CFG.phrasesB   = new Set(PHRASES_B_RAW.map(p=>p.replace(/\s+/g,"_")));
  CFG.phrasesC   = new Set(PHRASES_C_RAW.map(p=>p.replace(/\s+/g,"_")));

  // закрытые классы (B)
  CFG.closedB = {
    PRON:  new Set(D?.closedB?.PRON  || []),
    AUX:   new Set(D?.closedB?.AUX   || []),
    MODAL: new Set(D?.closedB?.MODAL || []),
    PREP:  new Set(D?.closedB?.PREP  || []),
    CONJ:  new Set(D?.closedB?.CONJ  || [])
  };

  // мягкие модификаторы/филлеры (C) и исключения -ly
  CFG.softC        = new Set(D?.softC        || []);
  CFG.lyExceptions = new Set(D?.lyExceptions || []);

  // числа/даты/дни/месяцы/числительные
  const MONTHS       = new Set(D?.months      || []);
  const WEEKDAYS     = new Set(D?.weekdays    || []);
  const NUMBER_WORDS = new Set(D?.numberWords || []);

  // причастия V3 (irregular)
  const IRREG_V3 = new Set(D?.irregularV3 || []);

  // фразовые глаголы (A)
  if(!window.PHRASES_A2)   window.PHRASES_A2   = new Set(D?.phrasalsA2   || []);
  if(!window.PHRASES_A3)   window.PHRASES_A3   = new Set(D?.phrasalsA3   || []);
  if(!window.SEPARABLE_A2) window.SEPARABLE_A2 = new Set(D?.separableA2  || []);

  // ========= helpers =========
  function clamp01(x){ return Math.max(0, Math.min(1, x)); }

  // --- сборка регулярок для A-фразалов ---
  let __A2_RE=null, __A3_RE=null;
  function __buildPhrasalRegex(){
    if(__A2_RE && __A3_RE) return;
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    __A2_RE = [...window.PHRASES_A2].map(k=>{
      const [v,p] = k.split("_");
      return { k, re: new RegExp(`\\b${esc(v)}(?:s|es|ed|ing)?\\s+${esc(p)}\\b`, "gi") };
    });
    __A3_RE = [...window.PHRASES_A3].map(k=>{
      const [v,m,pr] = k.split("_");
      return { k, re: new RegExp(`\\b${esc(v)}(?:s|es|ed|ing)?\\s+${esc(m)}\\s+${esc(pr)}\\b`, "gi") };
    });
  }

  // --- склейка B/C-фраз и A-фразалов в однословники (подчёркивания) ---
  const __esc = s => s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

  // ==== MOBILE ADJUNCTS (fixed & dynamic) ====
  const MOBILE_FIXED = new Set([
    // frequency & time
    "every day","every week","every month","every year",
    "every morning","every afternoon","every evening","every night",
    "each day","each week","each month","each year",
    "every single day","day by day","day after day","night after night",
    "once in a while","from time to time","every now and then","every now and again",
    "now and then","now and again","again and again",
    "all the time","most of the time","a lot of the time",
    "from now on","up to now","until now","by now","for now","for good",
    "for a while","for ages","for a long time","before long","not long after",
    "right now","just now","right away","straight away","at once","soon after",
    "the day before yesterday","the day after tomorrow",
    "this morning","this afternoon","this evening","last night",
    "last week","last month","last year","next week","next month","next year",

    // dayparts / calendar
    "in the morning","in the afternoon","in the evening",
    "at night","at noon","at midnight","at dawn","at dusk",
    "late at night","early in the morning",
    "at the weekend","on the weekend","over the weekend",
    "at the beginning of the day","at the end of the day",
    "at the beginning of the week","at the end of the week",
    "at the beginning of the month","at the end of the month",
    "at the beginning of the year","at the end of the year",
    "in the first place","in the end",

    // transport / place
    "by car","by bus","by train","by plane","by taxi","by bike","by bicycle",
    "by tram","by subway","by underground","by metro","by ship","by boat","by ferry",
    "on foot","on the way","on my way","on his way","on her way","on their way",
    "at home","at work","at school","at university","in class","in bed",
    "on the bus","on the train","on the plane",

    // discourse markers (soft C)
    "of course","in fact","at least","at most","at first","at last","after all",
    "by the way","in general","in particular","on the whole","above all",
    "for example","for instance","as a result","as a consequence","in the end",
    "to be honest","to be fair","to be frank","frankly speaking",
    "in other words","at the same time","on the contrary","by contrast","in contrast",

    // degree
    "a bit","a little bit","kind of","sort of","a lot","a great deal",
    "for the most part","in part","to some extent","to a certain extent","to a great extent"
  ]);

  function collapseMobileDynamic(s){
    const join = arr => arr.map(x=>__esc(x)).join("|");
    const WD = Array.from(WEEKDAYS || []);
    const MM = Array.from(MONTHS || []);

    if(WD.length){
      s = s.replace(new RegExp(`\\b(every|each)\\s+(${join(WD)})\\b`,"gi"),
        (_,a,day)=> `${a}_${day}`);
      s = s.replace(new RegExp(`\\b(on|this|next|last)\\s+(${join(WD)})\\b`,"gi"),
        (_,p,day)=> `${p}_${day}`);
      s = s.replace(new RegExp(`\\b(on|this|next|last)\\s+(${join(WD)})\\s+(morning|afternoon|evening|night)\\b`,"gi"),
        (_,p,day,part)=> `${p}_${day}_${part}`);
    }

    if(MM.length){
      s = s.replace(new RegExp(`\\b(in|during)\\s+(${join(MM)})\\b`,"gi"),
        (_,p,mon)=> `${p}_${mon}`);
    }
    s = s.replace(/\\bin\\s+(\\d{4})\\b/gi, (_,y)=> `in_${y}`);

    s = s.replace(/\\b(in)\\s+the\\s+(morning|afternoon|evening)\\b/gi, (_,p,t)=> `${p}_the_${t}`);
    s = s.replace(/\\b(at)\\s+(night|noon|midnight|dawn|dusk)\\b/gi, (_,p,t)=> `${p}_${t}`);

    s = s.replace(/\\b(at|on)\\s+the\\s+weekend\\b/gi, (_,p)=> `${p}_the_weekend`);
    s = s.replace(/\\bover\\s+the\\s+weekend\\b/gi, 'over_the_weekend');

    s = s.replace(/\\b(this|next|last)\\s+(week|month|year)\\b/gi, (_,a,per)=> `${a}_${per}`);

    s = s.replace(/\\bthe\\s+day\\s+(before|after)\\s+(yesterday|tomorrow)\\b/gi, (_,b,ref)=> `the_day_${b}_${ref}`);

    s = s.replace(/\\b(once|twice)\\s+a\\s+(day|week|month|year)\\b/gi, (_,q,per)=> `${q}_a_${per}`);
    s = s.replace(/\\b(\\d+)\\s+times?\\s+(a|per)\\s+(day|week|month|year)\\b/gi,
      (_,n,prep,per)=> `${n}_times_${prep}_${per}`);
    s = s.replace(/\\bevery\\s+other\\s+(day|week|month|year)\\b/gi, (_,per)=> `every_other_${per}`);

    s = s.replace(/\\bby\\s+(car|bus|train|plane|taxi|bike|bicycle|tram|subway|underground|metro|ship|boat|ferry)\\b/gi,
      (_,mode)=> `by_${mode}`);
    s = s.replace(/\\bon\\s+foot\\b/gi, 'on_foot');
    s = s.replace(/\\bon\\s+the\\s+way\\b/gi, 'on_the_way');
    s = s.replace(/\\b(my|his|her|their)\\s+way\\b/gi, (_,p)=> `${p}_way`);

    return s;
  }

  function isMobileAdjunct(tok){
    const t = (tok||"").toLowerCase();
    if (MOBILE_FIXED.has(t.replace(/_/g,' '))) return true;
    if (/^(every|each|this|next|last|by|on|in|over|at|for|until|up|from|the)_/.test(t)) return true;
    if (/^\\d+_times_(a|per)_(day|week|month|year)$/.test(t)) return true;
    if (/^(once|twice)_a_(day|week|month|year)$/.test(t)) return true;
    if (/^every_other_(day|week|month|year)$/.test(t)) return true;
    if (/^(on|this|next|last)_(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(_(morning|afternoon|evening|night))?$/.test(t)) return true;
    if (/^(in|during)_(january|february|march|april|may|june|july|august|september|october|november|december)$/.test(t)) return true;
    if (/^in_\\d{4}$/.test(t)) return true;
    if (/^(at|on|over)_the_weekend$/.test(t)) return true;
    if (/^(in_the_(morning|afternoon|evening)|at_(night|noon|midnight|dawn|dusk))$/.test(t)) return true;
    if (/^by_(car|bus|train|plane|taxi|bike|bicycle|tram|subway|underground|metro|ship|boat|ferry)$/.test(t)) return true;
    if (/^(on_foot|on_the_way|[a-z]+_way)$/.test(t)) return true;
    return false;
  }

  function preCollapsePhrases(s){
    const all = [...PHRASES_B_RAW, ...PHRASES_C_RAW, "each other","one another", ...Array.from(MOBILE_FIXED) ];
    all.forEach(p=>{
      const re = new RegExp("\\\\b"+__esc(p).replace(/\\s+/g,"\\\\s+")+"\\\\b","gi");
      s = s.replace(re, p.replace(/\\s+/g,"_"));
    });
    __buildPhrasalRegex();
    if(__A3_RE) __A3_RE.forEach(({k,re})=>{ s = s.replace(re, k); });
    if(__A2_RE) __A2_RE.forEach(({k,re})=>{ s = s.replace(re, k); });
    return s;
  }

  // --- эвристики форм ---
  function looksGerund(w){ return /^[a-z]+ing$/.test(w||""); }
  function looksV3(w){
    if (!w) return false;
    if (IRREG_V3.has(w)) return true;
    return /^[a-z]+(ed|en)$/.test(w);
  }

  // --- раскрытие сокращений перед чисткой ---
  function expandContractions(s){
    // normalize apostrophes once
    s = s.replace(/[´`’]/g, "'");

    // negatives
    s = s.replace(/\\b(can)['’]?t\\b/gi, '$1 not');
    s = s.replace(/\\b(could|should|would|might|must|need|dare)['’]?n['’]?t\\b/gi, '$1 not');
    s = s.replace(/\\b(is|are|was|were|has|have|had)['’]?n['’]?t\\b/gi, '$1 not');
    s = s.replace(/\\b(don)['’]?t\\b/gi, 'do not');
    s = s.replace(/\\b(doesn)['’]?t\\b/gi, 'does not');
    s = s.replace(/\\b(didn)['’]?t\\b/gi, 'did not');
    s = s.replace(/\\bwon['’]?t\\b/gi, 'will not');
    s = s.replace(/\\bshan['’]?t\\b/gi, 'shall not');
    s = s.replace(/\\bain['’]?t\\b/gi, 'is not');

    // double contractions (rare)
    s = s.replace(/\\b(should|would|could)['’]?n['’]?t['’]?ve\\b/gi, '$1 not have');

    // pronoun contractions
    s = s.replace(/\\b(I|you|he|she|it|we|they)['’]m\\b/gi, '$1 am');
    s = s.replace(/\\b(I|you|he|she|it|we|they)['’]re\\b/gi, '$1 are');
    s = s.replace(/\\b(I|you|he|she|it|we|they)['’]ve\\b/gi, '$1 have');
    s = s.replace(/\\b(I|you|he|she|it|we|they)['’]ll\\b/gi, '$1 will');
    s = s.replace(/\\b(I|you|he|she|it|we|they)['’]d\\b/gi, '$1 would'); // default 'd → would

    // colloquials / extras
    s = s.replace(/\\by['’]?all\\b/gi, 'you all');
    s = s.replace(/\\bkinda\\b/gi, 'kind of');
    s = s.replace(/\\bsorta\\b/gi, 'sort of');
    s = s.replace(/\\boutta\\b/gi, 'out of');
    s = s.replace(/\\b(cause|cuz|coz)\\b/gi, 'because');
    s = s.replace(/\\blemme\\b/gi, 'let me');
    s = s.replace(/\\bgimme\\b/gi, 'give me');
    s = s.replace(/\\bgonna\\b/gi, 'going to');
    s = s.replace(/\\bwanna\\b/gi, 'want to');
    s = s.replace(/\\bgotta\\b/gi, 'got to');
    s = s.replace(/\\bma['’]?am\\b/gi, 'madam');
    s = s.replace(/\\b['’]em\\b/gi, 'them');
    s = s.replace(/\\bgonna['’]?ve\\b/gi, 'going to have');
    s = s.replace(/\\b(would)a\\b/gi, 'would have');
    s = s.replace(/\\b(could)a\\b/gi, 'could have');
    s = s.replace(/\\b(should)a\\b/gi, 'should have');
    s = s.replace(/\\b(might)a\\b/gi, 'might have');
    s = s.replace(/\\b(must)a\\b/gi, 'must have');

    // special
    s = s.replace(/\\blet['’]s\\b/gi, 'let us');
    s = s.replace(/\\bcannot\\b/gi, 'can not');
    s = s.replace(/\\btry and\\b/gi, 'try to');
    s = s.replace(/\\bo['’]clock\\b/gi, 'of the clock');

    // 's disambiguation (has/is)
    s = s.replace(/\\b(he|she|it|who|that|there|what|where|here)['’]s\\s+([A-Za-z]+)/gi,
      (m,sub,next)=> looksV3((next||'').toLowerCase()) ? `${sub} has ${next}` : `${sub} is ${next}`);

    return s;
  }

  // US/UK orthography normalization (equivalence)
  function equalUSUK(a,b){
    const reps=[
      [/\\bcheque\\b/g, 'check'], [/\\baeroplane\\b/g, 'airplane'], [/\\btyre\\b/g, 'tire'],
      [/isation$/g, 'ization'], [/ise$/g, 'ize'], [/our$/g, 'or'], [/yse$/g, 'yze'],
      [/\\bdefence\\b/g, 'defense'], [/\\boffence\\b/g, 'offense'], [/\\blabour\\b/g, 'labor'],
      [/\\btravelling\\b/g, 'traveling'], [/\\btravelled\\b/g, 'traveled'], [/\\btraveller\\b/g, 'traveler'],
      [/\\bcentre\\b/g, 'center'], [/\\btheatre\\b/g, 'theater'], [/\\bmetre\\b/g, 'meter'], [/\\blitre\\b/g, 'liter'],
      [/\\bjewellery\\b/g, 'jewelry'], [/\\bgrey\\b/g, 'gray'], [/\\bcatalogue\\b/g, 'catalog'], [/\\bdialogue\\b/g, 'dialog'],
      [/\\bprogramme\\b/g, 'program']
    ];
    const norm = x => reps.reduce((y,[re,to])=> (y||'').replace(re,to), x||'');
    return norm(a)===norm(b);
  }

  // number words / ordinals equivalence
  const __NUM_WORDS = new Map([
    ['zero',0],['one',1],['two',2],['three',3],['four',4],['five',5],['six',6],['seven',7],['eight',8],['nine',9],
    ['ten',10],['eleven',11],['twelve',12],['thirteen',13],['fourteen',14],['fifteen',15],['sixteen',16],['seventeen',17],['eighteen',18],['nineteen',19],
    ['twenty',20],['thirty',30],['forty',40],['fifty',50],['sixty',60],['seventy',70],['eighty',80],['ninety',90],
    ['hundred',100],['thousand',1000],['million',1000000]
  ]);

  function asNumber(x){
    if (!x) return null;
    const s0 = String(x).toLowerCase();
    if (/^\\d+$/.test(s0)) return +s0;
    if (__NUM_WORDS.has(s0)) return __NUM_WORDS.get(s0);
    if (/^\\d+(st|nd|rd|th)$/.test(s0)) return +s0.replace(/(st|nd|rd|th)$/,'');

    const ORD_SIMPLE = new Map([
      ['first',1],['second',2],['third',3],['fourth',4],['fifth',5],['sixth',6],['seventh',7],['eighth',8],['ninth',9],
      ['tenth',10],['eleventh',11],['twelfth',12],['thirteenth',13],['fourteenth',14],['fifteenth',15],
      ['sixteenth',16],['seventeenth',17],['eighteenth',18],['nineteenth',19],
      ['twentieth',20],['thirtieth',30],['fortieth',40],['fiftieth',50],['sixtieth',60],['seventieth',70],['eightieth',80],['ninetieth',90]
    ]);
    if (ORD_SIMPLE.has(s0)) return ORD_SIMPLE.get(s0);

    const tensMap = new Map([['twenty',20],['thirty',30],['forty',40],['fifty',50],['sixty',60],['seventy',70],['eighty',80],['ninety',90]]);
    const onesMap = new Map([['one',1],['two',2],['three',3],['four',4],['five',5],['six',6],['seven',7],['eight',8],['nine',9]]);
    const ord1    = new Map([['first',1],['second',2],['third',3],['fourth',4],['fifth',5],['sixth',6],['seventh',7],['eighth',8],['ninth',9]]);
    if (s0.includes('_')){
      const [a,b] = s0.split('_');
      if (tensMap.has(a) && onesMap.has(b)) return tensMap.get(a)+onesMap.get(b);
      if (tensMap.has(a) && ord1.has(b)) return tensMap.get(a)+ord1.get(b);
    }
    return null;
  }

  // --- лемма головы фразала и свёртка разделяемых пар ---
  const __IRREG_BASE = { went:"go", gone:"go", did:"do", done:"do", saw:"see", seen:"see", took:"take", taken:"take",
    made:"make", gave:"give", given:"give", got:"get", gotten:"get", wrote:"write", written:"write", brought:"bring",
    bought:"buy", came:"come", ran:"run", taught:"teach", told:"tell", thought:"think", kept:"keep", left:"leave",
    found:"find", felt:"feel", held:"hold", paid:"pay", read:"read", led:"lead", sat:"sit", slept:"sleep",
    spoke:"speak", spoken:"speak", tore:"tear", torn:"tear", wore:"wear", worn:"wear" };

  function lemmaBase(w){
    let t=(w||"").toLowerCase();
    if(__IRREG_BASE[t]) return __IRREG_BASE[t];
    // -ies / -ied -> -y
    if(/ies$/.test(t)) return t.replace(/ies$/, 'y');
    if(/ied$/.test(t)) return t.replace(/ied$/, 'y');
    // safe -ing stripping (avoid nouns like morning/building)
    const ING_BLACK = new Set(['thing','morning','evening','building','meeting','ceiling','parking','funding','king','string','wing']);
    if(/^[a-z]*[aeiou][a-z]*ing$/.test(t) && t.length>=5 && !ING_BLACK.has(t)){
      let stem = t.slice(0,-3);
      if(/(.)\\1$/.test(stem)) stem = stem.slice(0,-1);
      if(!/[aeiou]$/.test(stem)) stem += 'e';
      t = stem;
    }
    else if(/ed$/.test(t)){
      let stem = t.replace(/ed$/,'');
      if(/(.)\\1$/.test(stem)) stem = stem.slice(0,-1);
      t = stem;
    }
    else if(/(es|s)$/.test(t)){
      t=t.replace(/(es|s)$/,''); 
    }
    return t;
  }

  function collapseSeparableA2(tokens){
    const win=4;
    for(let i=0;i<tokens.length;i++){
      const vbase = lemmaBase(tokens[i]);
      for(let j=i+1;j<Math.min(tokens.length, i+1+win); j++){
        const p = tokens[j];
        const key = `${vbase}_${p}`;
        if(window.SEPARABLE_A2.has(key)){
          tokens[i] = key;
          tokens.splice(j,1);
          i = Math.max(-1, i-2);
          break;
        }
        // allow one "joker" between verb and particle (pron/short/softC)
        if (j===i+2){
          const mid = tokens[i+1];
          const key2 = `${vbase}_${p}`;
          const isJoker = (CFG.closedB.PRON.has(mid) || CFG.shortSet.has(mid) || CFG.softC.has(mid));
          if (isJoker && window.SEPARABLE_A2.has(key2)){
            tokens[i] = key2;
            tokens.splice(j,1);
            i = Math.max(-1, i-2);
            break;
          }
        }
      }
    }
    return tokens;
  }

  function isNumberLike(tok){
    return /^(\\d{1,3}(,\\d{3})*|\\d+)(\\.\\d+)?$/.test(tok)
        || /^(\\d{1,2}(:\\d{2}){1,2})$/.test(tok)
        || /^\\d+(st|nd|rd|th)$/.test(tok);
  }
  function isDateLike(tok){
    return MONTHS.has(tok) || WEEKDAYS.has(tok)
        || /^\\d{4}$/.test(tok)
        || /^\\d{1,2}[\\/-]\\d{1,2}([\\/-]\\d{2,4})?$/.test(tok);
  }
  function isClosedClassB(tok){
    const C = CFG.closedB;
    return C.PRON.has(tok) || C.AUX.has(tok) || C.MODAL.has(tok) || C.PREP.has(tok) || C.CONJ.has(tok);
  }
  function isSoftC(tok){
    if (CFG.softC.has(tok)) return true;
    if (tok.endsWith("ly") && !CFG.lyExceptions.has(tok)) return true;
    return false;
  }
  function isShort(tok){ return CFG.shortSet.has(tok); }

  function isPhrasalAKey(key){
    return (window.PHRASES_A2 && window.PHRASES_A2.has(key)) || (window.PHRASES_A3 && window.PHRASES_A3.has(key));
  }

  // ---- базовый классификатор ----
  function classify(tok){
    if (tok.includes("_")){
      if (isPhrasalAKey(tok)) return "A";
      if (CFG.phrasesB.has(tok)) return "B";
      if (CFG.phrasesC.has(tok)) return "C";
      const parts = tok.split("_");
      if (parts.every(p => isClosedClassB(p) || isShort(p))) return "B";
    }
    if (CFG.criticalA.has(tok)) return "A";
    if (CFG.temporalA.has(tok)) return "A";
    if (isNumberLike(tok) || isDateLike(tok) || NUMBER_WORDS.has(tok)) return "A";
    if (isClosedClassB(tok)) return "B";
    if (isSoftC(tok)) return "C";
    if (isShort(tok)) return "SHORT";
    return "A";
  }

  // ---- контекстный классификатор (AUX → критикал по mode) ----
  function classifyCtx(tokens, i){
    const tok  = tokens[i];
    const next = tokens[i+1] || "";

    if (tok.includes("_")){
      if (isPhrasalAKey(tok)) return "A";
      if (CFG.phrasesB.has(tok)) return "B";
      if (CFG.phrasesC.has(tok)) return "C";
      const parts = tok.split("_");
      if (parts.every(p => isClosedClassB(p) || isShort(p))) return "B";
    }

    if (CFG.criticalA.has(tok)) return "A";

    if (CFG.closedB.AUX.has(tok)) {
      const mode = (CFG.auxCritical && CFG.auxCritical.mode) || "all";
      if (mode === "all") return "A";
      if (mode === "contextual") {
        if (["be","am","is","are","was","were","been","being"].includes(tok)) {
          if (looksGerund(next) || looksV3(next)) return "A";
          return "B"; // копула
        }
        if (["have","has","had"].includes(tok)) {
          if (looksV3(next)) return "A";
          return "A"; // лексическое have
        }
        if (["do","does","did"].includes(tok)) {
          if (next==="not") return "A";
          if (isClosedClassB(next) || isSoftC(next) || isShort(next)) return "B"; // чистый AUX
          return "A"; // лексическое do
        }
      }
    }

    if (CFG.temporalA.has(tok) || isNumberLike(tok) || isDateLike(tok) || NUMBER_WORDS.has(tok)) return "A";
    if (isClosedClassB(tok)) return "B";
    if (isSoftC(tok)) return "C";
    if (isShort(tok)) return "SHORT";
    return "A";
  }

  function weight(cls){ return CFG.weights[cls] || 1.0; }

  // расстояния
  function levenshtein(a,b){
    const dp=Array(a.length+1).fill().map(()=>Array(b.length+1).fill(0));
    for(let i=0;i<=a.length;i++)dp[i][0]=i;
    for(let j=0;j<=b.length;j++)dp[0][j]=j;
    for(let i=1;i<=a.length;i++){
      for(let j=1;j<=b.length;j++){
        const cost=(a[i-1]===b[j-1])?0:1;
        dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+cost);
      }
    }
    return dp[a.length][b.length];
  }
  
  // --- расстояния: Damerau (только соседняя транспозиция) ---
  function damerau(a,b){
    if(!a || !b) return false;
    if(a.length!==b.length) return false;
    for(let i=0;i<a.length-1;i++){
      if(a[i]!==b[i]){
        return (a[i]===b[i+1] && a[i+1]===b[i]) && a.slice(i+2)===b.slice(i+2);
      }
    }
    return false;
  }

  // ======= Подсказки (единая функция) =======
  // Возвращает: { pHint, hintUsed, hintStrong, hintDetails }
  function calcHintPenalty(info, denom, n){
    if(!info || !info.total){
      return {pHint:0, hintUsed:false, hintStrong:false, hintDetails:null};
    }
    const revealed = Math.max(0, info.revealed|0);
    const total    = Math.max(revealed, info.total|0);
    const fRaw     = Math.max(0, Math.min(1, revealed/total));
    if (fRaw === 0) {
      return { pHint: 0, hintUsed: false, hintStrong: false, hintDetails: null };
    }
    const curve = (CFG && CFG.penalty && CFG.penalty.hintCurve) ? CFG.penalty.hintCurve : { type:'sigmoid', k:12, x0:0.45 };
    let f = fRaw;
    if(curve.type === 'sigmoid'){
      const k  = (curve.k  ?? 12);
      const x0 = (curve.x0 ?? 0.45);
      f = 1/(1 + Math.exp(-k*(fRaw - x0)));
    }
    const shortBoost = (n<=4) ? 1.4 : (n<=6 ? 1.2 : 1.0);
    const maxCap = denom * ((CFG && CFG.penalty && (CFG.penalty.hintMaxFrac!=null)) ? CFG.penalty.hintMaxFrac : 0.20);
    let base     = denom * f * 0.50;
    const hintStrong = (fRaw >= 0.6) || (n<=5 && fRaw >= 0.8);
    const pHint  = Math.min(maxCap, base * shortBoost);
    const hintDetails = { n, revealed, total, fRaw:+fRaw.toFixed(2), f:+f.toFixed(2), shortBoost, base:+base.toFixed(3), cap:+maxCap.toFixed(3) };
    return { pHint, hintUsed: true, hintStrong, hintDetails };
  }


  let lastRec=null;
  function tokensSafe(arr, idx){ return (idx>=0 && idx<arr.length) ? arr[idx] : null; }

  // ======== НОВОЕ: выравнивание по DP ========
  function pairScore(tok, u, cls){
    let score=0, dist=null, tol=null, matchType="miss";
    if (u==null) return {score, matchType, dist, tol};
    if (cls==="SHORT"){
      if (tok===u){ score=1; matchType="exact"; }
      return {score, matchType, dist, tol};
    }
    if (tok===u){ score=1; matchType="exact"; }
    else{
      // numeric equivalence
      const na=asNumber(tok), nb=asNumber(u);
      if (na!=null && nb!=null && na===nb){ score=1; matchType="num-eq"; }
      else if (equalUSUK(tok,u)){ score=0.95; matchType="usuk"; }
      else{
        // morph soft-check
        const tb = lemmaBase(tok), ub = lemmaBase(u);
        const morphDiff = (tb===ub) && (
          tok===ub+"s" || tok===ub+"es" || tok===ub+"ed" || tok===ub+"ing" ||
          u  ===tb+"s" || u  ===tb+"es" || u  ===tb+"ed" || u  ===tb+"ing"
        );
        if (morphDiff){ score = 0.85; matchType="morph"; }
        else {
          dist=levenshtein(tok,u); const len=tok.length; tol=(len<=4)?0:(len<=8?1:2);
          if (dist<=tol){ score=Math.max(0,1-dist/len); matchType="fuzzy"; }
          else if (damerau(tok,u)){
            score = (tok.length>=5) ? 0.5 : 0.3;
            matchType="damerau";
          }
        }
      }
    }
    return {score, matchType, dist, tol};
  }

  // Возвращает user-токены, выровненные под длину эталона, и список лишних
  function alignByDP(tTokens, uTokens){
    const n=tTokens.length, m=uTokens.length;
    const classes = Array.from({length:n}, (_,i)=> classifyCtx(tTokens, i));
    const weights = classes.map(c => weight(c));

    const dp = Array.from({length:n+1},()=>Array(m+1).fill(0));
    const bt = Array.from({length:n+1},()=>Array(m+1).fill(null));

    for (let i=1;i<=n;i++){
      for (let j=1;j<=m;j++){
        const {score} = pairScore(tTokens[i-1], uTokens[j-1], classes[i-1]);
        const diag = dp[i-1][j-1] + score*weights[i-1];
        const up   = dp[i-1][j];
        const left = dp[i][j-1];
        let best = diag, act='diag';
        if (up > best){ best=up; act='up'; }
        if (left > best){ best=left; act='left'; }
        dp[i][j]=best; bt[i][j]=act;
      }
    }

    let i=n, j=m;
    const alignedU = Array(n).fill("(пусто)");
    const alignedIdxU = Array(n).fill(-1);
    const extraIdx = [];
    while (i>0 || j>0){
      const act = bt[i]?.[j] || (i>0?'up':'left');
      if (act==='diag'){ alignedU[i-1] = uTokens[j-1] ?? "(пусто)"; alignedIdxU[i-1]=j-1; i--; j--; }
      else if (act==='up'){ i--; }
      else { extraIdx.push(j-1); j--; }
    }
    extraIdx.reverse();
    const extraTokens = extraIdx.map(k => uTokens[k]);
    return { alignedU, alignedIdxU, extraTokens };
  }

  // ===== основная проверка =====
  function check(){
    const targetEl = document.getElementById("target");
    const answerEl = document.getElementById("answer");
    const target = targetEl ? targetEl.innerText : "";
    const typed  = answerEl ? answerEl.value : "";

    let tTokens=tokenize(target), uTokens=tokenize(typed);

    // свёртка разделяемых фразалов
    tTokens = collapseSeparableA2(tTokens);
    uTokens = collapseSeparableA2(uTokens);

    // НОВОЕ: выравнивание ввода под эталон
    let { alignedU, alignedIdxU, extraTokens } = alignByDP(tTokens, uTokens);

    // Reconcile MOBILE adjuncts: pull from extras into aligned slots so reordering doesn't penalize
    (function reconcileMobile(){
      const bag = new Map();
      extraTokens.forEach(x=> bag.set(x, (bag.get(x)||0)+1));
      for(let i=0;i<tTokens.length;i++){
        if(alignedU[i]==="(пусто)" && isMobileAdjunct(tTokens[i])){
          const k = tTokens[i];
          if(bag.get(k)>0){
            alignedU[i] = k;
            alignedIdxU[i] = -1; // out-of-order marker
            bag.set(k, bag.get(k)-1);
          }
        }
      }
      const rest=[]; bag.forEach((cnt,key)=>{ for(let c=0;c<cnt;c++) rest.push(key); });
      extraTokens = rest;
    })();

    const log=[]; const push=(s)=>log.push(s);
    const sep = (title)=>{ log.push("\\n—— " + title + " ——"); };

    if(!tTokens.length){
      setHTML("vis","");
      setHTML("bar","");
      setHTML("summary","");
      setHTML("classStats","");
      setText("log","Пустой эталон: нечего сравнивать");
      setHTML("rec",'<span class="badge" style="color:#f80">Нет эталона</span>');
      return;
    }

    // ===== Блок метрик =====
    let baseScore=0,denom=0;
    let denomA=0,EA=0,coverageSum=0;
    let scores=[]; let classStats={A:{ok:0,near:0,bad:0},B:{ok:0,near:0,bad:0}};

    sep("Нормализация и токены");
    push(`Эталон (norm): "${normalize(target)}"`);
    push(`Ввод (norm):   "${normalize(typed)}"`);
    push(`Токены эталона (${tTokens.length}): [${tTokens.join(' | ')}]`);
    push(`Токены ввода   (${uTokens.length}): [${uTokens.join(' | ')}]`);
    push(`Выровненные    (${alignedU.length}): [${alignedU.join(' | ')}]`);

    sep("Покомпонентная классификация и совпадения");

    for(let i=0;i<tTokens.length;i++){
      const tok=tTokens[i];
      const u=alignedU[i]||"(пусто)";
      const cls=classifyCtx(tTokens, i);
      const w=weight(cls);
      denom+=w; if(cls==="A")denomA+=w;

      const rs = pairScore(tok,u,cls);
      const score = rs.score; const matchType=rs.matchType; const dist=rs.dist; const tol=rs.tol;

      baseScore += score*w;
      if(cls==="A")EA+=score*w;
      if(score>=0.5)coverageSum+=w;

      if(cls==="A"||cls==="B"){
        if(score===1) classStats[cls].ok++;
        else if(score>=0.5) classStats[cls].near++;
        else classStats[cls].bad++;
      }

      let reason;
      if (matchType==="exact") reason = "точное совпадение";
      else if (matchType==="fuzzy") reason = `фаззи: dist=${dist}, допуск=${tol}`;
      else if (matchType==="damerau") reason = "перестановка соседних букв";
      else reason = (u && u !== "(пусто)") ? "несовпадение" : "пропуск";
      scores.push({idx:i,tok,u,cls,w,score,matchType,dist,tol,userIndex: alignedIdxU[i]});
      push(`${String(i+1).padStart(2,'0')}. [${cls}, w=${w}] «${tok}» ↔ «${u}» → score=${score.toFixed(2)} (${reason})`);
    }

    // ===== Штрафы =====
    let penalties=0;
    let pExtraRaw=0, pExtra=0, extraList=[];
    let pOrderRaw=0, pOrder=0;
    let pHint=0, hintUsed=false, hintStrong=false, hintDetails=null;

    // лишние слова (те, что не попали в выравнивание)
    extraTokens.forEach(tok=>{
      const cls = classify(tok);
      const w   = weight(cls);
      const soft = (cls === "C" || cls === "SHORT") ? 0.5 : 1.0;
      const base = CFG.penalty.extraPerWord * soft * w;
      const p    = Math.min(base, CFG.penalty.extraCapToken);
      pExtraRaw += p;
      extraList.push({tok, p, cls});
    });
    pExtra = Math.min(pExtraRaw, denom*CFG.penalty.extraCapPhrase);
    penalties += pExtra;

    // порядок слов (A): считаем инверсии по индексам исходного ввода
    function countInversionsWithAdjacency(arr){
      let adj=0;
      for(let i=0;i<arr.length-1;i++) if(arr[i] > arr[i+1]) adj++;
      let total=0;
      for(let i=0;i<arr.length;i++){
        for(let j=i+1;j<arr.length;j++){
          if(arr[i] > arr[j]) total++;
        }
      }
      return { total, adj };
    }
    const aIndices = scores
      .filter(s=> s.cls==="A" && s.score >= (CFG.orderMatchMin ?? 0.8) && s.userIndex>=0)
      .map(s=> s.userIndex);

    let inv={ total:0, adj:0 };
    if (aIndices.length>=2){
      inv = countInversionsWithAdjacency(aIndices);
      const nonAdj = Math.max(0, inv.total - inv.adj);
      const k = CFG.penalty.orderA * CFG.weights.A;
      pOrderRaw = k * (nonAdj + 0.5*inv.adj);
    }
    const capOrder=denom*CFG.penalty.orderCap;
    const pOrder = Math.min(pOrderRaw, capOrder);
    penalties += pOrder;

    // подсказка (hint) — читаем из localStorage и считаем через calcHintPenalty()
    try{
      const info = JSON.parse(localStorage.getItem('anki_hint_info')||'null');
      const n = tTokens.length;
      const hp = calcHintPenalty(info, denom, n);
      pHint = hp.pHint; hintUsed = hp.hintUsed; hintStrong = hp.hintStrong; hintDetails = hp.hintDetails;
      penalties += pHint;
    }catch(e){}
    try{ localStorage.removeItem('anki_hint_info'); }catch(e){}

    // ===== Метрики =====
    const E = Math.max(0, baseScore - penalties);
    const OverallNum = denom>0 ? (E/denom*100) : 0;
    const Overall=OverallNum.toFixed(1);
    const ContentNum = denomA>0 ? (EA/denomA*100) : 100;
    const ContentUI=denomA>0?ContentNum.toFixed(1):"—";
    const CoverageNum = denom>0 ? (coverageSum/denom*100) : 0;
    const Coverage=CoverageNum.toFixed(1);
    const FinalScoreNum=(0.7*OverallNum+0.3*CoverageNum);
    const FinalScore=FinalScoreNum.toFixed(1);

    // ===== Визуализация токенов =====
    const html=scores.map((s,i)=>{
      const g=Math.round(s.score*255), r=255-g;
      const col=`rgb(${r},${g},0)`;
      let misMark="";
      const prev=tokensSafe(tTokens,i-1), next=tokensSafe(tTokens,i+1);
      const isLocalSwap = s.u && s.u!=="(пусто)" && ((prev && s.u===prev) || (next && s.u===next));
      if(s.cls!=="A" && isLocalSwap) misMark=" border:2px dashed #ff0";
      return `<span title="${s.tok} · ${s.cls} · ${s.score.toFixed(2)}" style="background:${col};${misMark}">${s.u}</span>`;
    }).join(" ");
    const extrasHtml=extraTokens.map(x =>
      `<span title="EXTRA: ${x}" style="background:#555;color:#fff;border:2px solid #f44">${x}</span>`
    ).join(" ");
    setHTML("vis", html+(extrasHtml?(" "+extrasHtml):""));

    // ===== Прогресс-бар и карточки =====
    setHTML("bar", `<div style="height:100%;width:${Overall}%;background:#21d07a"></div>`);
    setHTML("summary",
      `<div>Overall: ${Overall}%</div>
       <div>Content: ${ContentUI}${denomA>0?'%':''}</div>
       <div>Coverage: ${Coverage}%</div>
       <div>FinalScore: ${FinalScore}%</div>`);
    setHTML("classStats",
      `<div><b>A</b>: ✅${classStats.A.ok} · ⚠️${classStats.A.near} · ❌${classStats.A.bad}</div>
       <div><b>B</b>: ✅${classStats.B.ok} · ⚠️${classStats.B.near} · ❌${classStats.B.bad}</div>`);

    // ===== Подробный LOG =====
    sep("Штрафы: лишние слова");
    if(extraList.length===0) push("— нет");
    else extraList.forEach(x=> push(`+${x.p.toFixed(2)} за лишнее слово «${x.tok}» (cap-на-слово ≤ ${CFG.penalty.extraCapToken})`));
    const extraCapPhrase = denom*CFG.penalty.extraCapPhrase;
    if(pExtraRaw>pExtra) push(`CAP по фразе: min(${pExtraRaw.toFixed(2)}, ${extraCapPhrase.toFixed(2)}) → применено ${pExtra.toFixed(2)}`);
    push(`Итого за лишние: ${pExtra.toFixed(2)} (порог по фразе ≤ ${(extraCapPhrase).toFixed(2)})`);

    sep("Штрафы: порядок слов (только класс A)");
    if(aIndices.length<2){ push("— нет"); }
    else {
      const nonAdj = Math.max(0, inv.total - inv.adj);
      push(`Инверсии: всего=${inv.total}, соседних=${inv.adj}, несмежных=${nonAdj}`);
    }
    if(pOrderRaw>pOrder) push(`CAP по порядку: min(${pOrderRaw.toFixed(2)}, ${(capOrder).toFixed(2)}) → применено ${pOrder.toFixed(2)}`);
    push(`Итого за порядок: ${pOrder.toFixed(2)} (cap ≤ ${(capOrder).toFixed(2)})`);

    sep("Штрафы: подсказка");
    if(!hintDetails) push("— подсказка не использовалась");
    else {
      push(`Параметры: n=${hintDetails.n}, раскрыто ${hintDetails.revealed}/${hintDetails.total} (f=${hintDetails.f}), base=${hintDetails.base}, boost=${hintDetails.shortBoost}`);
      if(hintStrong) push("Сильная подсказка: ограничивает рекомендацию (см. ниже)");
      push(`Итого за подсказку: ${pHint.toFixed(2)}`);
    }

    sep("Итоги");
    push(`Сумма базовых баллов (baseScore) = ${baseScore.toFixed(2)} из возможных Σвесов = ${denom.toFixed(2)}`);
    push(`Штрафы: лишние=${pExtra.toFixed(2)} + порядок=${pOrder.toFixed(2)} + подсказка=${pHint.toFixed(2)} → Σштрафов = ${(pExtra+pOrder+pHint).toFixed(2)}`);
    push(`Итоговые баллы E = max(0, B − Σштрафов) = ${E.toFixed(2)}`);
    push(`Accuracy (Overall) = ${Overall}%`);
    push(`Content Accuracy (A) = ${denomA>0?ContentUI+'%':'—'}`);
    push(`Coverage = ${Coverage}%`);
    push(`FinalScore = ${FinalScore}%`);
    setText("log", log.join("\\n"));

    // ===== Рекомендация =====
    const rec=classifyResult(OverallNum,ContentNum,CoverageNum,FinalScoreNum, { usedHint: hintUsed, strong: hintStrong, nTokens: tTokens.length });
    lastRec=rec;
    const color=rec.startsWith("Again")?"#f44":(rec.startsWith("Hard")?"#f80":(rec.startsWith("Good")?"#2bdc63":"#43a0ff"));
    setHTML("rec", `<span class="badge" style="color:${color}">Рекомендация: ${rec}</span>`);
  }

  // === Рекомендации (учёт подсказок и гистерезис) ===
  function classifyResult(OverallNum,ContentNum,CoverageNum,FinalScoreNum, opts={}){
    const usedHint = !!opts.usedHint;
    const strong   = !!opts.strong;
    const nTokens  = opts.nTokens || 999;

    if(ContentNum<70) return "Again (Content<70%)";
    if(CoverageNum<60) return "Again (Coverage<60%)";

    if (strong && nTokens<=5) {
      if (OverallNum>=90) return "Hard (hint)";
      return "Again (hint)";
    }

    let rec;
    if(OverallNum>=99) rec="Easy";
    else if(OverallNum>=90) rec="Good";
    else if(OverallNum>=70) rec="Hard";
    else rec="Again";

    if (usedHint) {
      if (rec==="Easy") rec="Good";
      if (strong && rec==="Good") rec="Hard";
    }

    if(rec==="Hard" && lastRec==="Again" && FinalScoreNum<CFG.hysteresis.again) rec="Again";
    if(rec==="Again" && lastRec==="Hard" && FinalScoreNum>=CFG.hysteresis.hard) rec="Hard";

    return rec;
  }

  // ===== утилиты DOM =====
  function setHTML(id, html){ const el=document.getElementById(id); if(el) el.innerHTML=html; }
  function setText(id, txt){ const el=document.getElementById(id); if(el) el.innerText=txt; }

  // ===== нормализация и токенизация =====
  function normalize(s){
    s = (s||"").normalize('NFC').toLowerCase();
    s = expandContractions(s);
    s = preCollapsePhrases(s);
    s = collapseMobileDynamic(s);
    s = s.replace(/['\\u2018\\u2019\\u02BC\\u0060\\u00B4\\u2032\\u02B9\\uFF07]/g,"");
    s = s.replace(/[\\u201C\\u201D]/g,'"');
    s = s.replace(/[.,!?;:"«»(){}\\[\\]—–\\-\\/\\\\]/g,' ');
    s = s.replace(/\\s+/g,' ').trim();
    return s;
  }
  function joinCompoundNumbers(arr){
    const tens = new Set(['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety']);
    const ones = new Set(['one','two','three','four','five','six','seven','eight','nine']);
    const ord1 = new Set(['first','second','third','fourth','fifth','sixth','seventh','eighth','ninth']);
    const out=[];
    for(let i=0;i<arr.length;i++){
      const a=arr[i], b=arr[i+1];
      if (tens.has(a) && (ones.has(b) || ord1.has(b))) { out.push(a+'_'+b); i++; }
      else out.push(a);
    }
    return out;
  }
  function joinNumberPhrases(arr){
    const NUM = new Set([
      'zero','one','two','three','four','five','six','seven','eight','nine',
      'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen',
      'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety',
      'hundred','thousand','million','and',
      'first','second','third','fourth','fifth','sixth','seventh','eighth','ninth',
      'tenth','eleventh','twelfth','thirteenth','fourteenth','fifteenth','sixteenth','seventeenth','eighteenth','nineteenth',
      'twentieth','thirtieth','fortieth','fiftieth','sixtieth','seventieth','eightieth','ninetieth'
    ]);
    const out=[];
    for(let i=0;i<arr.length;i++){
      if(!NUM.has(arr[i])){ out.push(arr[i]); continue; }
      let j=i, buf=[arr[j++]];
      while(j<arr.length && NUM.has(arr[j])) buf.push(arr[j++]);
      if (buf.length>1 || buf.includes('hundred') || buf.includes('thousand')) { out.push(buf.join('_')); i=j-1; }
      else out.push(arr[i]);
    }
    return out;
  }
  function tokenize(s){
    const parts = normalize(s).split(/\\s+/).filter(Boolean);
    const step1 = joinCompoundNumbers(parts);
    const step2 = joinNumberPhrases(step1);
    return step2;
  }

  // ===== авто-инициализация =====
  (function init(){
    // предупредим, если фразалы не загружены
    if ((window.PHRASES_A2.size+window.PHRASES_A3.size)===0){
      console.warn('[phrasals] нет наборов PHRASES_A2/A3 — фразалы не будут учитываться');
    }
    try{
      const val=localStorage.getItem('anki_tmp_answer')||"";
      const $hidden=document.getElementById('answer');
      if($hidden) $hidden.value=val;
      localStorage.removeItem('anki_tmp_answer');
    }catch(e){}
    // Два кадра, чтобы DOM и статические наборы успели прогрузиться
    requestAnimationFrame(()=>requestAnimationFrame(check));
  })();

  // === Подсказка: вспомогательные функции для UI ===
  window.ankiComputeHintTotal = function(){
    const el = document.getElementById('target');
    const txt = el ? el.innerText : "";
    const norm = (txt || "").normalize('NFC')
      .toLowerCase()
      .replace(/[.,!?;:"«»(){}\\[\\]—–\\-\\/\\\\'`’“”]/g,' ')
      .replace(/\\s+/g,'').trim();
    return norm.length;
  };
  window.ankiSetHintInfo = function(total, revealed){
    try{
      const t = Math.max(0, total|0);
      const r = Math.min(Math.max(0, revealed|0), t);
      localStorage.setItem('anki_hint_info', JSON.stringify({ total:t, revealed:r }));
    }catch(e){}
  };

  // На всякий случай экспортируем check(), если хочешь вручную триггерить
  window.ankiCheck = check;
})();