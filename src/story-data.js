export const story = {
  id: "school-mystery-demo",
  title: "放課後の不思議なメッセージ",
  opening:
    "放課後、誰もいないはずのパソコン教室で、一台の画面だけが青白く光っていました。画面には『学校に隠された秘密を見つけて』と表示されています。",
  startNodeId: "round-1",
  tokenDemo: {
    context: "放課後、私は",
    candidates: [
      { text: "図書室へ", probability: null },
      { text: "不思議な音を", probability: null },
      { text: "友達と", probability: null }
    ]
  },
  nodes: {
    "round-1": {
      id: "round-1",
      round: 1,
      prompt: "最初にどうする？",
      choices: [
        {
          id: "r1-envelope",
          text: "机の上に置かれた、差出人のない封筒を開けました。",
          nextNodeId: "round-2-envelope"
        },
        {
          id: "r1-cat",
          text: "廊下を走り去った白い猫を追いかけました。",
          nextNodeId: "round-2-cat"
        },
        {
          id: "r1-message",
          text: "画面のメッセージに『あなたは誰？』と入力しました。",
          nextNodeId: "round-2-message"
        }
      ]
    },
    "round-2-envelope": {
      id: "round-2-envelope",
      round: 2,
      prompt: "封筒には古い校内図が入っていた。次は？",
      choices: [
        {
          id: "r2e-library",
          text: "地図に赤い印が付いた図書室へ向かいました。",
          nextNodeId: "round-3-logic"
        },
        {
          id: "r2e-friends",
          text: "一人では危険だと思い、友達を呼びました。",
          nextNodeId: "round-3-team"
        },
        {
          id: "r2e-teacher",
          text: "まず先生に見せようと、職員室へ走りました。",
          nextNodeId: "round-3-chaos"
        }
      ]
    },
    "round-2-cat": {
      id: "round-2-cat",
      round: 2,
      prompt: "猫は立入禁止の階段で立ち止まった。次は？",
      choices: [
        {
          id: "r2c-follow",
          text: "勇気を出して、猫と一緒に暗い階段を上りました。",
          nextNodeId: "round-3-chaos"
        },
        {
          id: "r2c-record",
          text: "スマートフォンで周囲を撮影しながら進みました。",
          nextNodeId: "round-3-logic"
        },
        {
          id: "r2c-call",
          text: "友達に現在地を送り、応援を頼みました。",
          nextNodeId: "round-3-team"
        }
      ]
    },
    "round-2-message": {
      id: "round-2-message",
      round: 2,
      prompt: "画面に『あなたたちの先輩です』と返事が来た。次は？",
      choices: [
        {
          id: "r2m-question",
          text: "秘密について、さらに質問を続けました。",
          nextNodeId: "round-3-logic"
        },
        {
          id: "r2m-shutdown",
          text: "怪しいと思い、パソコンの電源を切りました。",
          nextNodeId: "round-3-chaos"
        },
        {
          id: "r2m-share",
          text: "メッセージを友達にも見せ、全員で考えました。",
          nextNodeId: "round-3-team"
        }
      ]
    },
    "round-3-logic": {
      id: "round-3-logic",
      round: 3,
      prompt: "手掛かりを整理すると、三つの場所が浮かんだ。どこへ行く？",
      choices: [
        {
          id: "r3l-roof",
          text: "数字の並びを時刻だと考え、夕日の見える屋上へ向かいました。",
          nextNodeId: "round-4-discovery"
        },
        {
          id: "r3l-library",
          text: "暗号は本の番号だと考え、図書室の奥を探しました。",
          nextNodeId: "round-4-memory"
        },
        {
          id: "r3l-lab",
          text: "記号は回路図だと気づき、実習室へ向かいました。",
          nextNodeId: "round-4-future"
        }
      ]
    },
    "round-3-team": {
      id: "round-3-team",
      round: 3,
      prompt: "仲間が集まった。役割をどう分ける？",
      choices: [
        {
          id: "r3t-search",
          text: "校内図を分担して調べ、見つけた情報を共有しました。",
          nextNodeId: "round-4-discovery"
        },
        {
          id: "r3t-alumni",
          text: "卒業生の記録を調べ、メッセージの送り主を探しました。",
          nextNodeId: "round-4-memory"
        },
        {
          id: "r3t-build",
          text: "全員の得意分野を集め、手掛かりを読む装置を作りました。",
          nextNodeId: "round-4-future"
        }
      ]
    },
    "round-3-chaos": {
      id: "round-3-chaos",
      round: 3,
      prompt: "突然、校内放送から自分たちの名前が聞こえた。どうする？",
      choices: [
        {
          id: "r3c-broadcast",
          text: "放送室へ駆け込み、誰が呼んだのか確かめました。",
          nextNodeId: "round-4-discovery"
        },
        {
          id: "r3c-hide",
          text: "いったん物陰に隠れ、放送を最後まで聞きました。",
          nextNodeId: "round-4-memory"
        },
        {
          id: "r3c-answer",
          text: "近くのマイクを使い、『ここにいる！』と答えました。",
          nextNodeId: "round-4-future"
        }
      ]
    },
    "round-4-discovery": {
      id: "round-4-discovery",
      round: 4,
      prompt: "ついに秘密の箱を発見した。中に入っていたものは？",
      choices: [
        {
          id: "r4d-letter",
          text: "箱の中には、未来の生徒へ宛てた卒業生たちの手紙が入っていました。",
          nextNodeId: null
        },
        {
          id: "r4d-key",
          text: "箱の中には、まだ誰も知らない部屋の鍵が入っていました。",
          nextNodeId: null
        },
        {
          id: "r4d-empty",
          text: "箱は空でしたが、ふたの裏に『答えは君たちが作る』と書かれていました。",
          nextNodeId: null
        }
      ]
    },
    "round-4-memory": {
      id: "round-4-memory",
      round: 4,
      prompt: "秘密は学校の記憶につながっていた。最後に分かったことは？",
      choices: [
        {
          id: "r4m-project",
          text: "メッセージは、完成しなかった昔の生徒プロジェクトから届いていました。",
          nextNodeId: null
        },
        {
          id: "r4m-tradition",
          text: "すべては、新入生を歓迎するために受け継がれてきた仕掛けでした。",
          nextNodeId: null
        },
        {
          id: "r4m-photo",
          text: "古い写真の中には、今と同じ場所に立つ自分たちの姿が写っていました。",
          nextNodeId: null
        }
      ]
    },
    "round-4-future": {
      id: "round-4-future",
      round: 4,
      prompt: "集めた手掛かりが未来へのメッセージになった。結末は？",
      choices: [
        {
          id: "r4f-ai",
          text: "画面の正体は、歴代の生徒が少しずつ育てた学校案内AIでした。",
          nextNodeId: null
        },
        {
          id: "r4f-next",
          text: "自分たちも次の生徒へ謎を残すことにし、新しい物語を書き始めました。",
          nextNodeId: null
        },
        {
          id: "r4f-morning",
          text: "すべての画面が消え、翌朝には昨夜の出来事を覚えている人はいませんでした。",
          nextNodeId: null
        }
      ]
    }
  }
};
