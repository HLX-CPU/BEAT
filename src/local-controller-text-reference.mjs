// Bounded grammar for quoted-language questions. Unknown syntax stays conservative.
// Text recognition is not execution authorization; model safety and native permissions still apply.
export function explicitTextReferenceOnly(value) {
  const text=String(value||'').trim();
  if(!text||text.length>2000||text.includes('§'))return false;
  const pairs={'“':'”','‘':'’','"':'"',"'":"'"};
  let masked='',count=0;
  for(let i=0;i<text.length;i++){
    const char=text[i],close=pairs[char];
    if(close){
      const end=text.indexOf(close,i+1);
      if(end<0)return false;
      const body=text.slice(i+1,end);
      if(!body||/[“”‘’"'\\]/.test(body))return false;
      masked+='§';count++;i=end;
    }else if(char==='”'||char==='’')return false;
    else masked+=char;
  }
  if(count<1||count>8)return false;
  masked=masked.replace(/\s/g,'');
  const subjects='§(?:(?:和|与|、)§)*';
  const explain='(?:请)?(?:只|仅)(?:解释|说明|比较|介绍)'+subjects+'(?:(?:的)?(?:含义|意思|区别|概念区别|通常含义|概念|功能|用途))?';
  const translate='(?:请)?(?:只|仅)(?:把|将)?(?:英文)?(?:短语|词语|命令|句子|文本)?§(?:翻译(?:为|成)|译成)(?:中文|英文|汉语|英语)';
  const translateLeading='(?:请)?(?:只|仅)翻译§(?:成|为)(?:中文|英文|汉语|英语)';
  const log='日志(?:中)?(?:引用|出现|包含)(?:了)?§[，,](?:请)?(?:只|仅)(?:解释|说明)(?:这(?:个|些|两个))?(?:英文)?(?:单词|词语|短语|命令)?(?:的)?(?:通常)?(?:含义|意思)';
  const negative='(?:不要(?:碰|触碰)我的文件|不执行(?:它|短语中的动作|该命令|这个命令)|不连接数据库也不执行它|不要运行脚本|不运行脚本|不要执行任何命令)';
  return new RegExp('^(?:'+explain+'|'+translate+'|'+translateLeading+'|'+log+')(?:[，,]'+negative+')*[。.!！?？]*$').test(masked);
}
