export default function Home() {
  return (
    <main className="flex h-screen flex-col bg-black text-white">
      <div className="border-b border-gray-800 p-4 text-xl font-bold flex items-center justify-between">
        <span>My AI Chat</span>
        <a
          href="/farm.html"
          className="rounded-full bg-green-700 px-4 py-1 text-sm text-white hover:bg-green-600 transition-colors"
        >
          🌾 小小农场
        </a>
      </div>

      <div className="flex-1 p-4">
        <div className="mb-4">
          <div className="mb-2 text-sm text-gray-400">
            用户
          </div>

          <div className="rounded-2xl bg-gray-900 p-4">
            你好
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm text-gray-400">
            AI
          </div>

          <div className="rounded-2xl bg-gray-800 p-4">
            你好，我是 AI 助手。
          </div>
        </div>
      </div>

      <div className="border-t border-gray-800 p-4">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-xl bg-gray-900 p-3 outline-none"
            placeholder="输入消息..."
          />

          <button className="rounded-xl bg-white px-4 py-2 text-black">
            发送
          </button>
        </div>
      </div>
    </main>
  )
}