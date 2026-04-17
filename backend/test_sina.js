const axios = require('axios');
axios.get('http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData', {
  params: {
    page: 1, num: 10, sort: 'symbol', asc: 1, node: 'hs_a', symbol: '', _s_r_a: 'page'
  }
}).then(res => {
  console.log(typeof res.data);
  console.log(Array.isArray(res.data));
  console.log(res.data.slice(0, 2));
});
