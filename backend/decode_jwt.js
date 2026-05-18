const token = process.argv[2];
const payload = Buffer.from(token.split('.')[1], 'base64').toString();
console.log(payload);
