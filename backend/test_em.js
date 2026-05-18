const http = require('http');

const options = {
  hostname: '31.push2.eastmoney.com',
  port: 80,
  path: '/api/qt/clist/get?pn=1&pz=10000&po=1&np=1&fs=m:1+t:2&fields=f12,f13,f14,f118,f26',
  method: 'GET',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'http://quote.eastmoney.com/',
    'Host': 'push2.eastmoney.com'
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log("m:1+t:2 =>", data);
  });
});
req.on('error', (e) => {
  console.error(`Problem: ${e.message}`);
});
req.end();
