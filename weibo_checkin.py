# 更新日期：2023.3.16
# 版本：1.0
# 最近开始关注微博超话，发现每天签到非常麻烦。于是就利用 GPT-4 写了一个 Python 脚本来自动签到微博超话。但是因为微博神奇般的刷新Cookie，所以该项目也只能图一乐，否则可能高频的手动更换Cookie并不能达到制作这个项目的初心！
import json
import random
import re
import requests
import time

# 在脚本开始时等待 0 到 7200 秒 (0 到 2 小时)
sleep_time = random.randint(0, 7)
time.sleep(sleep_time)

# 配置 headers 和 cookies
user_agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.140 Safari/537.36 Edge/17.17134",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.77 Safari/537.36",
]

headers = {
    "User-Agent": random.choice(user_agents),
    "Referer": "https://weibo.com/"
}

cookies = {
    "SUB": "你的Cookies"
}

def random_wait(min_wait=5, max_wait=15):
    wait_time = random.randint(min_wait, max_wait)
    time.sleep(wait_time)

def check_in(cookies, active_id):
    headers["User-Agent"] = random.choice(user_agents)
    url = f"https://weibo.com/p/{active_id}"
    session = requests.Session()
    session.cookies.update(cookies)
    random_wait()
    response = session.get(url, headers=headers)

    print(f"找到 active_id: {active_id}")

    # 在这里处理 active_id
    checkin_url = f"https://weibo.com/p/aj/general/button?id={active_id}&api=http://i.huati.weibo.com/aj/super/checkin"
    checkin_response = session.get(checkin_url, headers=headers)
    checkin_result = json.loads(checkin_response.text)
    if checkin_result["code"] == 382004:
        print("签到成功：今天已签到")
    else:
        print("签到结果：", checkin_result)

if __name__ == "__main__":
    print("Running Weibo check-in script...")
    super_topic_active_ids = [
        "1008080d055beb31fd94ce0399a1981d82afc5",
        "1008084b3f3945e087a0dd32f56c3603b7d153",
        # 添加更多超话 active_id
    ]

    random.shuffle(super_topic_active_ids)  # 随机化签到顺序

    for active_id in super_topic_active_ids:
        check_in(cookies, active_id)
        random_wait()  # 在签到之间添加随机等待时间

    print("Script finished.")


