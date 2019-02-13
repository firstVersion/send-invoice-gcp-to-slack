/**
 * Triggered from a change to a Cloud Storage bucket.
 *
 * @param {!Object} event Event payload and metadata.
 * @param {!Function} callback Callback function to signal completion.
 */

exports.notifySlack = (request, response) => {
  const   slackAPIToken = process.env.SLACK_API_TOKEN;
  const   slackChannelName = process.env.SLACK_CHANNEL_NAME;
  const   tableName = process.env.TABLE_NAME;
  const   fullBurst = process.env.FULL_BURST;
  //slack用テキスト生成
  const createMessage = function( billing_data, date ) {
   let msg = "```";
   let description = "";
   let cost = "";
   let diff = "";
   let sum = 0;
   msg += `\n\
< ${date.min_day} - ${date.max_day} > Invoice ${date.invoice_month.substr(0,4)}/${date.invoice_month.substr(4,2)}`;
    let today_cost = 0;
    let total_today_cost = 0;
    Object.keys(billing_data[0]).forEach(pj_name=>{
     //プロジェクトに依存しない請求はproject.idがnullになる
     today_cost = 0;
     if(billing_data[1][pj_name]) billing_data[1][pj_name].forEach( v => today_cost+=v.cost );
     total_today_cost += today_cost;
     msg += createMessageRow(pj_name == "null"?"Support":pj_name, billing_data[0][pj_name][0].cost)
     msg += " ("+spacer(`${Math.round(today_cost*100)/100}↑`,9,true)+")";
     sum += Number(billing_data[0][pj_name][0].cost);
   });
   msg += "\n―――――――――――――――――――――――――――";
   msg += createMessageRow("Sum",sum);
   msg += " ("+spacer(`${Math.round(total_today_cost*100)/100}↑`,9,true)+")";
   msg += "\n\n";
   if( fullBurst == 1 )
   Object.keys(billing_data[1]).forEach( pj_name=>{
     msg += `\n\n< ${billing_data[1][pj_name][0].ex_day} 0:00-24:00 > ${pj_name}`;
     billing_data[1][pj_name].forEach((v,i)=>{
       diff = v.diff_cost > 0 ? `${v.diff_cost}`+"↑" : `${-1*v.diff_cost}`+"↓";
       diff = spacer(diff, 9, true);
       msg += createMessageRow(v.service_description,v.cost)+` (${diff})`
     });
     msg += "\n\n";
   });
   return msg+"\n```";
 }

 //slackにテキストを送信する
 const sendMessage = function( token, ch_name, msg ) {
   let https       = require('https');
   let querystring = require("querystring")
   let data = querystring.stringify({
     token:   token,
     channel: ch_name,
     text:    msg
   });
   let options = {
     host:'slack.com',
     port:443,
     method:'POST',
     path:'/api/chat.postMessage',
     headers: {
       'Content-Type': 'application/x-www-form-urlencoded',
       'Content-Length': data.length
     }
   }
   let req = https.request(options,res=>{
     res.on('data', chunk=>{});
     res.on('end',  ()=>{  });
     res.on('error', err=>{ console.log(err); });
   });
   req.write(data);
   req.end();
 }

 //概要と価格を良しなにつなげてくれる
 const createMessageRow = function(description, cost){
   d = spacer(description, 20, false);
   c = spacer(`${Math.ceil(cost)}円`,9,true);
   return `\n${d}|${c}`;
 }

//文字列の右か左をスペースで埋める
 const spacer = function(str,numofspace,is_Left)
 {
   let result = str;
   if(is_Left)for( let i=0; i<numofspace - str.length; i++ )
      result = " "+result;
   else for( let i=0; i<numofspace - str.length; i++ )
      result = result+" ";
   return result;
 }

//とってきたデータを変形させる
 const reshapeData= function(values){
   let res = [];
   for (let i=0; i<2; i++)
   {
    res[i] = {};
    values[i].forEach( v => {
      if(Object.keys(res[i]).indexOf(v.pj_name)<0) res[i][v.pj_name] = [];
      res[i][v.pj_name].push(v);
    });
   }
   return res;
 }

 const getMinMaxDay = function(v){
     let min_day = v[0].min_day;
     let max_day = v[0].max_day;
     v.forEach(b=>{
       min_day = new Date(b.min_day).getTime() < new Date(min_day).getTime() ? b.min_day : min_day;
       max_day = new Date(b.max_day).getTime() > new Date(max_day).getTime() ? b.max_day : max_day;
     });
     return { min_day:min_day, max_day:max_day, invoice_month:v[0].invoice_month };
 }

 //ここから実行
 const {BigQuery} = require('@google-cloud/bigquery');
 const bq = new BigQuery({projectId: process.env.GCP_PROJECT});
 // 今日の請求額と一緒に前日の差額をとってくる
 const sql_today = {
   query: "\
   SELECT T.pj_name, T.sdict AS service_description, T.cost AS cost, ROUND(T.cost-Y.cost,3) AS diff_cost, T.ex_day\
    FROM\
     (SELECT project.id AS pj_name, service.description AS sdict, SUM(cost) AS cost, FORMAT_DATE('%m/%d',DATE_SUB(CURRENT_DATE() ,INTERVAL 1 DAY)) AS ex_day\
     FROM `"+tableName+"`\
     WHERE FORMAT_DATE('%Y-%m-%d',DATE_SUB(CURRENT_DATE() ,INTERVAL 1 DAY)) = FORMAT_DATE('%Y-%m-%d', DATE(export_time)) \
     GROUP BY project.id, service.description\
     ORDER BY project.id, service.description\
     LIMIT 100) T\
     INNER JOIN\
     (SELECT project.id AS pj_name, service.description AS sdict,SUM(cost) AS cost \
     FROM `"+tableName+"`\
     WHERE FORMAT_DATE('%Y-%m-%d',DATE_SUB(CURRENT_DATE() ,INTERVAL 2 DAY)) = FORMAT_DATE('%Y-%m-%d', DATE(export_time)) \
     GROUP BY project.id, service.description\
     ORDER BY project.id, service.description\
     LIMIT 100) Y\
    ON T.pj_name = Y.pj_name AND T.sdict = Y.sdict\
    WHERE T.cost > 0 OR Y.cost > 0;"};
//今月請求分の合計をとってくる
 const sql_month = {
   query: "\
   SELECT project.id AS pj_name, CEIL(SUM(cost)) AS cost, FORMAT_DATE('%m/%d',MIN(DATE(export_time))) AS min_day, FORMAT_DATE('%m/%d',MAX(DATE(export_time))) AS max_day, MAX(invoice.month) AS invoice_month\
   FROM  `"+tableName+"`\
   WHERE cost > 0\
   AND invoice.month=(SELECT MAX(invoice.month) FROM `"+tableName+"`)\
   GROUP BY project.id\
   ORDER BY project.id\
   LIMIT 50"};

let today = new Promise((res,rej)=>bq.query(sql_today).then(results => res(results[0])));
let month = new Promise((res,rej)=>bq.query(sql_month).then(results => res(results[0])));
Promise.all([month,today]).then(values=>{
  let rvalues = reshapeData(values);
  let minmaxday = getMinMaxDay(values[0]);
  let message = createMessage(rvalues,minmaxday);
  sendMessage(slackAPIToken, slackChannelName, message);
});
response.status(200).end();
}
