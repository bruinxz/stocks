const axios = require('axios');
axios.post('http://127.0.0.1:3000/api/auth/refresh', {}, {
  headers: {
    Cookie: 'refreshToken=test'
  }
}).then(res => console.log(res.data)).catch(e => console.log(e.response?.data || e.message));
