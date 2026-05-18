import requests

url = "http://82.push2.eastmoney.com/api/qt/clist/get"
params = {
    "pn": "1",
    "pz": "50",
    "po": "1",
    "np": "1",
    "ut": "bd1d9ddb04089700cf9c27f6f7426281",
    "fltt": "2",
    "invt": "2",
    "fid": "f3",
    "fs": "m:1 t:2,m:1 t:23",
    "fields": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f25,f22,f11,f62,f128,f136,f115,f152"
}
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
}
try:
    # Notice the '+' is URL encoded by requests if we pass dict, but let's test if it works
    params["fs"] = "m:1+t:2,m:1+t:23"
    res = requests.get(url, params=params, headers=headers, timeout=10)
    print(res.status_code)
    print(res.text[:200])
except Exception as e:
    print(f"Error 1: {e}")

try:
    url2 = "http://82.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs=m:1+t:2,m:1+t:23&fields=f12,f13,f14,f118,f26"
    res2 = requests.get(url2, headers=headers, timeout=10)
    print(res2.status_code)
    print(res2.text[:200])
except Exception as e:
    print(f"Error 2: {e}")
