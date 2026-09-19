/**
 * dsh-interviewer —— 浏览器侧（客户端插件）
 *
 * 这个文件不经过任何打包器，手写在 DSH 的浏览器模块格式里：
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *     factory(require) -> module.exports
 *
 * `require` 由加载器提供，仓库里的共享模块（react、ui-primitives 等）按名字解析。
 * 好处是没有构建步骤 —— 改完这个文件刷新浏览器即可，不用 tsc / tsdown。
 *
 * 注册进两个槽位（都是别的包已经声明好的，我只是往里加条目）：
 *
 *   sidebar.panellist  (list)   侧边栏的全局面板图标。list id 对应 main 的 key。
 *   main               (keyed)  中间面板。保留键 conversation 归会话，其他键自由。
 *
 * 两者靠 id/key 对上：侧边栏点 'interviewer'，中间就显示 'interviewer' 面板。
 */
window.__ModuleLoader__.load({
	id: 'dsh-interviewer',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const h = React.createElement;

		/**
		 * 浏览器内置语音识别。Chrome / Edge 有，Firefox 和 Safari 没有。
		 *
		 * ⚠ 关键：它**不是本地识别**。音频是发到浏览器厂商的服务器上转写的 ——
		 * Chrome 走 Google、Edge 走微软 Azure。所以国内网络下 Chrome 大概率失败
		 * （错误码会是 `network`），Edge 可能可以。
		 *
		 * 这条路径不花钱、不装东西，但能不能用取决于网络。所以它只是**第一选择**，
		 * 失败时必须能干净地报出原因（而不是静默不动），才好判断要不要上本地方案。
		 */
		const SpeechRec = (typeof window !== 'undefined')
			? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
			: null;

		/** 把浏览器给的错误码翻译成人能看懂的原因。 */
		function speechErrorHint(code) {
			switch (code) {
				case 'network':
					return '连不上识别服务。Chrome 的语音识别是把音频发到 Google 服务器做的，'
						+ '国内网络下这是最常见的原因 —— 换 Edge 试试，或者改用本地 whisper 方案。';
				case 'not-allowed':
					return '麦克风权限被拒。看地址栏左侧的权限图标，允许麦克风后重试。';
				case 'service-not-allowed':
					return '浏览器禁止了语音识别服务。';
				case 'audio-capture':
					return '没找到麦克风设备。';
				case 'no-speech':
					return '没听到声音，再试一次。';
				case 'aborted':
					return '识别被中断。';
				default:
					return '未知原因。';
			}
		}

		// ── 诊断探针 ──
		// 这几行是排查用的。① 出现说明浏览器拿到了模块；② 说明 apply 跑了；
		// ③ 说明槽位已被声明、注册成功。哪一步没出现，问题就在哪一环。
		// 定位完可以删掉。
		console.log('[dsh-interviewer] ① 客户端模块已加载');

		/** 这个插件提供的面板 id。 */
		const PANEL_ID = 'interviewer';

		/**
		 * 可选的面试官风格。
		 *
		 * 风格改变**怎么问**和**压力多大**，不改变铁律 —— 温和风格一样要追到底。
		 * 定义和范例见技能目录的 references/05-voices.md（主机侧已经把它读进系统提示词了）。
		 */
		const VOICES = ['温和引导', '务实工程', '冷峻压测', '学术严谨'];

		/** 面试设置的可选项。方向和职级决定难度与薪资档，轮次决定时长，风格决定问法。 */
		const DOMAINS = ['大模型 / Agent', 'Java 后端', '算法'];
		const LEVELS = ['校招', '初级', '中级', '高级', '专家'];
		const ROUNDS = ['技术一面', '技术二面', '主管面', 'HR 面'];

		/** 默认设置。点开设置弹窗时的初始值。 */
		const DEFAULT_CONFIG = {
			domain: DOMAINS[0],
			level: '高级',
			round: ROUNDS[0],
			voice: VOICES[0],
		};

		/** 配置的稳定标识，用来给面板做 remount 的 key（换了配置就重开一场）。 */
		function configKey(c) {
			return [c.domain, c.level, c.round, c.voice].join('|');
		}

		/**
		 * 需要哪些客户端服务。
		 *
		 * `layout` 必须在 inject 里声明 —— cordis 对未声明的服务会直接抛
		 * 「cannot get property "layout" without inject」，而不是返回 undefined。
		 * 我第一版漏了它，导致浮动按钮切面板的路径从来没成功过（静默降级成弹窗）。
		 */
		const inject = ['slots', 'layout'];

		// ------------------------------------------------------------ 样式
		// 内联样式：省掉 CSS Modules 那套构建。真做下去再抽出去。

		const S = {
			panel: {
				display: 'flex',
				flexDirection: 'column',
				// 内容列靠 align-items:center 居中。列自己有 maxWidth，
				// 否则在宽屏上面板会拉满整幅，读起来很累。
				alignItems: 'center',
				height: '100%',
				minHeight: 0,
				background: 'var(--dsh-bg, #0b1020)',
				color: 'var(--dsh-fg, #e2e8f0)',
				fontSize: 13.5,
			},
			header: {
				display: 'flex',
				alignItems: 'center',
				gap: 10,
				padding: '12px 16px',
				borderBottom: '1px solid rgba(148,163,184,0.16)',
				flex: 'none',
			},
			title: { fontWeight: 650, fontSize: 15 },
			tag: {
				fontSize: 11,
				padding: '2px 7px',
				borderRadius: 5,
				background: 'rgba(251,191,36,0.16)',
				color: '#fbbf24',
				border: '1px solid rgba(251,191,36,0.3)',
			},
			selectors: {
				display: 'flex',
				gap: 8,
				padding: '10px 16px',
				borderBottom: '1px solid rgba(148,163,184,0.12)',
				flex: 'none',
				flexWrap: 'wrap',
			},
			select: {
				background: 'rgba(30,41,59,0.7)',
				color: '#cbd5e1',
				border: '1px solid rgba(148,163,184,0.2)',
				borderRadius: 7,
				padding: '5px 9px',
				fontSize: 12.5,
				fontFamily: 'inherit',
			},
			body: {
				flex: 1,
				minHeight: 0,
				overflowY: 'auto',
				padding: 16,
				display: 'flex',
				flexDirection: 'column',
				gap: 10,
			},
			empty: {
				margin: 'auto',
				textAlign: 'center',
				color: '#64748b',
				lineHeight: 1.9,
				fontSize: 13,
			},
			composer: {
				flex: 'none',
				display: 'flex',
				gap: 8,
				padding: 12,
				borderTop: '1px solid rgba(148,163,184,0.16)',
			},
			input: {
				flex: 1,
				background: 'rgba(7,11,20,0.75)',
				color: '#e2e8f0',
				border: '1px solid rgba(148,163,184,0.2)',
				borderRadius: 9,
				padding: '9px 12px',
				fontSize: 13.5,
				fontFamily: 'inherit',
				outline: 'none',
				resize: 'none',
			},
			button: {
				background: 'rgba(96,165,250,0.85)',
				color: '#06101f',
				border: '1px solid rgba(96,165,250,0.85)',
				borderRadius: 9,
				padding: '0 18px',
				fontSize: 13.5,
				fontWeight: 600,
				fontFamily: 'inherit',
				cursor: 'pointer',
			},
			icon: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				fontSize: 15,
				lineHeight: 1,
			},
		};

		// ------------------------------------------------------------ 侧边栏图标

		/**
		 * 侧边栏的全局面板按钮。
		 * owner props: { size, selected }
		 */
		function SidebarIcon(props) {
			const size = (props && props.size) || 18;
			return h(
				'span',
				{
					style: Object.assign({}, S.icon, {
						width: size,
						height: size,
						fontSize: Math.round(size * 0.72),
					}),
					title: '模拟面试',
				},
				'试'
			);
		}

		// ------------------------------------------------------------ 面板

		/** 消息气泡和输入区的补充样式（S 在上面，这里只加面板专用的）。 */
		const B = {
			/**
			 * 面板内容列。
			 *
			 * 之前有个 maxWidth: 780 —— 那是给"全屏接管主区域"用的（宽屏上限宽更好读）。
			 * 现在窗口本身就是固定宽度，这层限制反而会在拖宽窗口时留出空白，去掉。
			 */
			column: {
				display: 'flex',
				flexDirection: 'column',
				width: '100%',
				height: '100%',
				minHeight: 0,
			},
			body: {
				flex: 1,
				minHeight: 0,
				overflowY: 'auto',
				padding: '14px 14px 6px',
				display: 'flex',
				flexDirection: 'column',
				gap: 9,
			},
			row: { display: 'flex', width: '100%' },
			bubble: {
				maxWidth: '82%',
				padding: '9px 13px',
				borderRadius: 10,
				fontSize: 13.5,
				lineHeight: 1.75,
				whiteSpace: 'pre-wrap',
				wordBreak: 'break-word',
			},
			bubbleUser: {
				background: 'rgba(96,165,250,0.16)',
				border: '1px solid rgba(96,165,250,0.3)',
				color: '#dbeafe',
			},
			bubbleAI: {
				background: 'rgba(30,41,59,0.6)',
				border: '1px solid rgba(148,163,184,0.18)',
				color: '#e2e8f0',
			},
			notice: {
				fontSize: 12.5,
				lineHeight: 1.8,
				padding: '9px 12px',
				borderRadius: 8,
				background: 'rgba(251,191,36,0.1)',
				border: '1px solid rgba(251,191,36,0.3)',
				color: '#fcd34d',
			},
			/** 紧凑状态行：一个小圆点 + 模型名，替代原来那一大块蓝色提示条。 */
			status: {
				display: 'flex',
				alignItems: 'center',
				fontSize: 11,
				color: '#64748b',
				padding: '2px 2px 4px',
				flex: 'none',
			},
			/** 语音状态行。正在听 / 实时中间结果用红色，失败原因用黄色。 */
			voiceOn: {
				fontSize: 11.5,
				color: '#fca5a5',
				padding: '3px 4px 2px',
				lineHeight: 1.65,
				wordBreak: 'break-word',
				flex: 'none',
			},
			voiceHint: {
				fontSize: 11.5,
				color: '#fbbf24',
				padding: '3px 4px 2px',
				lineHeight: 1.65,
				wordBreak: 'break-word',
				flex: 'none',
			},
			err: {
				fontSize: 12.5,
				lineHeight: 1.8,
				padding: '9px 12px',
				borderRadius: 8,
				background: 'rgba(248,113,113,0.12)',
				border: '1px solid rgba(248,113,113,0.35)',
				color: '#fca5a5',
			},
			meta: { fontSize: 11, color: '#64748b', marginTop: 4, textAlign: 'right' },
			ghost: {
				background: 'transparent',
				color: '#8595ad',
				border: '1px solid rgba(148,163,184,0.25)',
				borderRadius: 7,
				padding: '4px 10px',
				fontSize: 12,
				fontFamily: 'inherit',
				cursor: 'pointer',
			},

			// ---- 配置条（面试窗口里那一条只读摘要）----
			configStrip: {
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				flexWrap: 'wrap',
				padding: '5px 12px',
				fontSize: 11.5,
				color: '#8595ad',
				borderBottom: '1px solid rgba(148,163,184,0.12)',
				flex: 'none',
			},

			// ---- 面试状态条 ----
			// 比配置条更淡。它是读数，不是装饰 —— 只在有信息时才显示。
			stateStrip: {
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				flexWrap: 'wrap',
				padding: '3px 12px 5px',
				fontSize: 11,
				color: '#64748b',
				borderBottom: '1px solid rgba(148,163,184,0.12)',
				flex: 'none',
			},
			stateChip: {
				padding: '1px 6px',
				borderRadius: 5,
				background: 'rgba(148,163,184,0.10)',
				color: '#94a3b8',
			},

			// ---- 设置弹窗 ----
			// 背景遮罩要自己 opt-in 指针事件：shell.overlay 那一层是点击穿透的。
			backdrop: {
				position: 'fixed',
				inset: 0,
				zIndex: 45,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'rgba(3,6,12,0.6)',
				pointerEvents: 'auto',
			},
			dialog: {
				width: 320,
				maxWidth: 'calc(100vw - 32px)',
				padding: 18,
				borderRadius: 12,
				background: '#0f1629',
				border: '1px solid rgba(148,163,184,0.28)',
				boxShadow: '0 24px 60px rgba(0,0,0,0.65)',
				color: '#e2e8f0',
				fontSize: 13,
			},
			dialogTitle: { fontSize: 14.5, fontWeight: 650, marginBottom: 14 },
			field: { display: 'block', marginBottom: 10 },
			fieldLabel: { display: 'block', fontSize: 11.5, color: '#8595ad', marginBottom: 4 },
			fieldSelect: {
				width: '100%',
				padding: '6px 9px',
				borderRadius: 7,
				background: 'rgba(7,11,20,0.75)',
				color: '#e2e8f0',
				border: '1px solid rgba(148,163,184,0.22)',
				fontSize: 12.5,
				fontFamily: 'inherit',
				outline: 'none',
			},
			dialogNote: { fontSize: 11, color: '#64748b', lineHeight: 1.7, margin: '6px 0 0' },
			dialogActions: { display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' },
		};

		/**
		 * 面试设置弹窗。
		 *
		 * 为什么把设置和面试分开：点一下按钮就直接进对话，用户没有机会选方向/职级/风格 ——
		 * 而这三样决定整场面试的难度和问法，中途改又会让追问失去连贯性（同一话题里换风格，
		 * 追问就断了）。所以：**先设置，再开始。**
		 */
		function SetupModal(props) {
			const [draft, setDraft] = React.useState(props.initial || DEFAULT_CONFIG);

			const field = (label, key, items) => h(
				'label',
				{ key: key, style: B.field },
				h('span', { style: B.fieldLabel }, label),
				h(
					'select',
					{
						style: B.fieldSelect,
						value: draft[key],
						onChange: (e) => setDraft(Object.assign({}, draft, { [key]: e.target.value })),
					},
					items.map((it) => h('option', { key: it, value: it }, it))
				)
			);

			return h(
				'div',
				{ style: B.backdrop },
				h(
					'div',
					{ style: B.dialog },
					h('div', { style: B.dialogTitle }, '面试设置'),
					field('目标方向', 'domain', DOMAINS),
					field('目标职级', 'level', LEVELS),
					field('面试轮次', 'round', ROUNDS),
					field('面试官风格', 'voice', VOICES),
					h('div', { style: B.dialogNote },
						'前四项决定整场面试的难度和问法，开始后不建议再改。'),
					h(
						'div',
						{ style: B.dialogActions },
						h('button', { style: B.ghost, onClick: props.onCancel }, '取消'),
						h('button', {
							style: Object.assign({}, S.button, { padding: '6px 16px' }),
							onClick: () => props.onConfirm(draft),
						}, '开始面试')
					)
				)
			);
		}

		/**
		 * 状态条。state 为 null（第一轮还没回来）时返回 null，整条不占位。
		 *
		 * 显示三样：还剩多少分钟、计划推进到哪、当前话题是第几次提问。
		 * 最后一次到上限时标红 —— 这是给"追 5 轮"那个 bug 留的可视化证据。
		 */
		function stateStrip(state, nowMs) {
			if (!state || typeof state !== 'object') return null;

			const started = Number(state.startedAt) || nowMs;
			const budget = Number(state.budgetMin) || 45;
			const elapsed = Math.max(0, Math.floor((nowMs - started) / 60000));
			const left = Math.max(0, budget - elapsed);
			const plan = Array.isArray(state.plan) ? state.plan : [];
			const done = Array.isArray(state.done) ? state.done : [];
			const asks = Number(state.turnsOnTopic) || 0;
			const capped = asks >= 2;

			// ⚠ 只数**计划内**的完成项。实测里模型会顺手聊计划外的话题
			// （比如"开场准备"），也在 done 里留名 —— 直接显示 done.length
			// 会算出「计划 5 / 4」这种读不通的数。
			const planDone = plan.filter((p) => p && done.includes(p.topic)).length;

			// 计划里下一个还没聊的。状态机到上限时会**点名**它来换话题，
			// 这里跟着算一遍，用户就能看见"接下来它要问哪块" ——
			// 这也让"死磕一个话题"这件事变得肉眼可见，而不是靠感觉。
			let nextTopic = null;
			for (const p of plan) {
				if (p && p.topic !== state.topic && !done.includes(p.topic)) { nextTopic = p.topic; break; }
			}

			const kids = [];

			kids.push(h('span', { style: B.stateChip }, '⏱ 已用 ' + elapsed + ' / ' + budget + ' 分钟'));

			if (plan.length > 0) {
				kids.push(h('span', { style: B.stateChip }, '计划 ' + planDone + ' / ' + plan.length));
			}

			if (state.topic) {
				// asks 为 0 是正常的：状态机"乐观前进"之后，新话题从下一轮才算第 1 问。
				const label = asks === 0
					? '话题：' + state.topic + '　即将开始'
					: '话题：' + state.topic + '　第 ' + asks + ' 问';
				kids.push(h('span', {
					style: Object.assign({}, B.stateChip, capped
						? { background: 'rgba(251,191,36,0.16)', color: '#fbbf24' }
						: null),
				}, label + (capped
					? '　已追满 → 换到「' + (nextTopic || '反问环节') + '」'
					: '')));
			}

			if (left <= 5 && (plan.length > 0 || state.topic)) {
				kids.push(h('span', { style: { color: '#fbbf24' } }, '时间到了，该进反问环节'));
			}

			return h('div', { style: B.stateStrip }, kids);
		}

		/**
		 * 面试面板 = 中间面板本体。
		 *
		 * main 是 keyed/root 槽位，不绑定会话，拿不到 sessionId ——
		 * 所以这里的对话完全是面板自己的，不走 DSH 的会话历史。
		 * 模型调用由主机侧的路由代理（/interviewer/api/chat）。
		 *
		 * 配置通过 props 传进来（在设置弹窗里选好的）—— 面板自己不持有配置状态，
		 * 因为改了配置就该重开一场，而不是在同一场对话里换方向。
		 * 外层用 configKey 做 key，配置一换自然 remount，对话历史跟着清空。
		 */
		function InterviewPanel(props) {
			const config = props.config || DEFAULT_CONFIG;

			const [turns, setTurns] = React.useState([]);
			const [draft, setDraft] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [health, setHealth] = React.useState(null);

			// ---- 面试状态 ----
			// 主机侧是无状态的纯函数，状态由面板持有、每轮回传。
			// 里面装着：面试计划、当前话题、这个话题已经追了几次、还剩多少分钟、
			// 记下的边界和观察。**这不是为了给用户看**，是为了让模型每轮都能看到
			// 「我已经追了 2 次了」这个字面事实 —— 上一场面试就是死在这儿：
			// 模型每轮从零推导"该问什么"，于是抓着同一个话题追了 5 轮。
			const [istate, setIstate] = React.useState(null);
			const [clock, setClock] = React.useState(Date.now());

			const bodyRef = React.useRef(null);

			// ---- 语音输入 ----
			// 只用浏览器内置能力，不装依赖、不花钱。识别出来的文字直接追加进草稿，
			// 由用户自己按 Enter 发送 —— 不自动发，留一个改错的机会。
			const [listening, setListening] = React.useState(false);
			const [interim, setInterim] = React.useState('');
			const [voiceError, setVoiceError] = React.useState(null);
			const recRef = React.useRef(null);

			const stopMic = () => {
				try {
					if (recRef.current) recRef.current.stop();
				} catch (_) { /* 已经停了 */ }
				recRef.current = null;
				setListening(false);
				setInterim('');
			};

			const toggleMic = () => {
				if (listening) { stopMic(); return; }

				if (!SpeechRec) {
					setVoiceError('这个浏览器没有内置语音识别接口。Chrome 或 Edge 有，Firefox / Safari 没有。');
					return;
				}

				setVoiceError(null);
				setInterim('');

				const rec = new SpeechRec();
				rec.lang = 'zh-CN';
				rec.continuous = true;
				rec.interimResults = true;

				rec.onresult = (ev) => {
					let finalText = '';
					let live = '';
					for (let i = ev.resultIndex; i < ev.results.length; i++) {
						const r = ev.results[i];
						const txt = r[0] && r[0].transcript ? r[0].transcript : '';
						if (r.isFinal) finalText += txt;
						else live += txt;
					}
					if (finalText.length > 0) {
						setDraft((d) => (d.length > 0 && !/\s$/.test(d) ? d + ' ' : d) + finalText.trim());
					}
					setInterim(live);
				};

				rec.onerror = (ev) => {
					const code = ev && ev.error ? ev.error : 'unknown';
					setVoiceError('语音识别失败（' + code + '）：' + speechErrorHint(code));
					setListening(false);
					setInterim('');
					recRef.current = null;
				};

				rec.onend = () => {
					setListening(false);
					setInterim('');
				};

				try {
					rec.start();
					recRef.current = rec;
					setListening(true);
				} catch (e) {
					setVoiceError('启动识别失败：' + (e && e.message ? e.message : String(e)));
				}
			};

			// 进面板时问一次主机侧：路由有没有挂上、模型解析到没有
			React.useEffect(() => {
				let alive = true;
				fetch('/interviewer/api/health')
					.then((r) => r.json())
					.then((d) => { if (alive) setHealth(d); })
					.catch((e) => {
						if (alive) setHealth({ ok: false, error: String((e && e.message) || e) });
					});
				return () => { alive = false; };
			}, []);

			// 计时：让"已用多少分钟"在面板上真的走。面试官自己看的是每轮注入的
			// 状态块，但用户也该看得到这场面试的时间预算烧到哪了。
			React.useEffect(() => {
				if (istate === null) return undefined;
				const t = setInterval(() => setClock(Date.now()), 15000);
				return () => clearInterval(t);
			}, [istate]);

			// 新消息进来就滚到底
			React.useEffect(() => {
				const el = bodyRef.current;
				if (el) el.scrollTop = el.scrollHeight;
			}, [turns, busy, error]);

			const buildBrief = () => [
				'本轮设定：',
				'- 目标方向：' + config.domain,
				'- 目标职级：' + config.level,
				'- 面试轮次：' + config.round,
				'- 面试官风格：' + config.voice,
				'',
				'风格决定问法和压力，不改变铁律。四种风格的定义与范例见 SOP 里的 voices 一节。',
				'开场规则：先按 SOP 收集缺的要素（简历由候选人在对话里提供）。',
				'要素齐了之后用一两句话说明本轮安排，然后直接问第一个问题。',
				'不要问「准备好了吗」，不要自我介绍，不要复述简历。',
			].join('\n');

			const send = async () => {
				const text = draft.trim();
				if (text.length === 0 || busy) return;

				const next = turns.concat([{ role: 'user', text }]);
				setTurns(next);
				setDraft('');
				setBusy(true);
				setError(null);

				try {
					const res = await fetch('/interviewer/api/chat', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							messages: next,
							brief: buildBrief(),
							// ⚠ 这个值不能小。实测 maxTokens=200 时模型输出 0 个字 ——
							// 因为**推理（thinking）token 也计入 maxTokens**，额度被思考吃光
							// 就没有余额吐答案了。400 勉强能跑，但思考长度会波动，留足余量。
							maxTokens: 1600,
							// 状态回传。第一次是 null，主机侧会开一场新的（定好时间预算）。
							state: istate,
						}),
					});
					const data = await res.json();
					if (!data.ok) throw new Error(data.error || ('HTTP ' + res.status));
					// 主机侧已经把状态块从回复里摘掉了，data.text 是纯给候选人看的话
					if (data.state) setIstate(data.state);
					setClock(Date.now());
					setTurns(next.concat([{ role: 'assistant', text: data.text }]));
				} catch (e) {
					setError(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			};

			const notice = (() => {
				if (health === null) return null;
				if (health.ok === false) {
					return h('div', { style: B.err }, '连不上主机侧：' + (health.error || '未知错误'));
				}
				if (!health.route) {
					return h('div', { style: B.notice },
						'主机侧已就绪，但没解析到模型路由。检查 settings.yaml 里的 agent-default-model，'
						+ '或在插件 config 里配 provider / model。');
				}
				// 紧凑状态：一个小圆点 + 模型名。之前那一大块蓝色提示条太占地方，
				// 而它其实只在出问题时才需要被注意。
				return h('div', { style: B.status },
					h('span', { style: { color: '#4ade80' } }, '●'),
					h('span', null, ' ' + health.route.model),
					h('span', null, busy ? '' : '　' + turns.length + ' 轮'),
					health.hasSop ? null : h('span', { style: { color: '#fbbf24' } }, '　SOP 未找到'));
			})();

			return h(
				'div',
				{ style: S.panel },
				h(
					'div',
					{ style: B.column },
					// 配置条：把选好的设置显示出来，并提供回到设置弹窗的入口。
					// 之前这里是四个下拉框，占了一整行 —— 现在设置提前到了弹窗里。
					h(
						'div',
						{ style: B.configStrip },
						h('span', null, config.domain),
						h('span', { style: { color: '#334155' } }, '·'),
						h('span', null, config.level),
						h('span', { style: { color: '#334155' } }, '·'),
						h('span', null, config.round),
						h('span', { style: { color: '#334155' } }, '·'),
						h('span', null, config.voice),
						h('button', {
							style: Object.assign({}, B.ghost, {
								marginLeft: 'auto', padding: '1px 8px', fontSize: 11,
							}),
							disabled: busy,
							title: '重新设置（会清空当前这场对话）',
							onClick: props.onSetup,
						}, '设置')
					),
					// 状态条：把面试官脑子里的东西摊开给用户看。
					// 这既是给用户的进度感，也是一个**可验证的读数** ——
					// 上一场面试"同一话题追了 5 轮"，在这里会直接显示成「第 3 问」并变红，
					// 一眼就能看出状态机有没有在管用。
					stateStrip(istate, clock),
					h(
						'div',
						{ style: B.body, ref: bodyRef },
						notice,
						turns.length === 0
							? h(
									'div',
									{ style: S.empty },
									h('div', { style: { fontSize: 14, marginBottom: 6, color: '#94a3b8' } }, '说说你的情况'),
									h('div', null, '直接发消息即可开始。第一句可以只写「开始面试」。'),
									h('div', null, '简历可以粘进来，或者说一下你要面哪个岗位。')
								)
							: turns.map((t, i) => h(
									'div',
									{ key: i, style: Object.assign({}, B.row, {
										justifyContent: t.role === 'user' ? 'flex-end' : 'flex-start',
									}) },
									h('div', {
										style: Object.assign({}, B.bubble,
											t.role === 'user' ? B.bubbleUser : B.bubbleAI),
									}, t.text)
								)),
						busy ? h('div', { style: Object.assign({}, B.row, { justifyContent: 'flex-start' }) },
							h('div', { style: Object.assign({}, B.bubble, B.bubbleAI, { color: '#8595ad' }) }, '…')) : null,
						error ? h('div', { style: B.err }, error) : null
					),
					h(
						'div',
						{ style: S.composer },
						h('textarea', {
							style: S.input,
							rows: 2,
							value: draft,
							placeholder: listening
								? '正在听… 说完点 ■ 停止'
								: (busy ? '等待面试官…' : '输入你的回答，Enter 发送，Shift+Enter 换行'),
							disabled: busy,
							onChange: (e) => setDraft(e.target.value),
							onKeyDown: (e) => {
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault();
									send();
								}
							},
						}),
						h(
							'button',
							{
								style: Object.assign(
									{},
									B.ghost,
									{ padding: '0 11px', fontSize: 15, lineHeight: 1 },
									listening ? { color: '#fca5a5', borderColor: 'rgba(248,113,113,0.55)' } : null
								),
								title: SpeechRec
									? (listening ? '停止录音' : '用语音回答（浏览器内置识别）')
									: '这个浏览器不支持内置语音识别',
								onClick: toggleMic,
							},
							listening ? '■' : '🎤'
						),
						h(
							'button',
							{
								style: Object.assign({}, S.button, (busy || draft.trim().length === 0)
									? { opacity: 0.45, cursor: 'default' } : null),
								disabled: busy || draft.trim().length === 0,
								onClick: send,
							},
							'发送'
						)
					),
					// 语音状态：正在听 / 实时中间结果 / 失败原因
					(listening || interim || voiceError)
						? h(
								'div',
								{ style: voiceError ? B.voiceHint : B.voiceOn },
								listening ? '● 正在听' : '',
								interim ? '　' + interim : '',
								voiceError || ''
							)
						: null
				)
			);
		}

		// ------------------------------------------------------------ 悬浮窗口
		//
		// 为什么不再用 main 槽位（全屏接管中间区域）：
		//   那会占掉整个主区域，用户得先"返回会话"才能干别的；而且侧边栏入口
		//   现在还没渲染出来 —— 进去就出不来。太重，也太霸道。
		//
		// 为什么用 shell.overlay：
		//   ui-layout 文档原话是"给你自己的全框架界面用的增量座位"，由布局框架
		//   声明，新增 id 是加在现有条目旁边而不是替换它们。而且这一层是**点击
		//   穿透**的，条目自己 opt-in 到指针事件即可，不会挡住下面的界面。
		//
		// 收起态是一个右下角小按钮，展开态是一个可拖的卡片。同一个组件的两种
		// 状态，所以不需要跨组件同步开关 —— 之前那套订阅可以删掉了。

		/** 期望尺寸。实际尺寸会被视口收窄，见 winSize()。 */
		const WIN_W = 800;
		const WIN_H = 520;
		const WIN_MARGIN = 12;

		/**
		 * 实际尺寸。
		 *
		 * 定死宽高在小窗口 / 窄屏上会直接溢出屏幕外，拖都拖不回来 ——
		 * 所以宽高都要先被视口收住再使用。
		 */
		function winSize() {
			const vw = (typeof window !== 'undefined' && window.innerWidth) || 1200;
			const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
			return {
				w: Math.min(WIN_W, Math.max(280, vw - WIN_MARGIN * 2)),
				h: Math.min(WIN_H, Math.max(240, vh - WIN_MARGIN * 2)),
				vw,
				vh,
			};
		}

		function FloatingInterview() {
			// 三个阶段：closed（小按钮）→ setup（设置弹窗）→ open（面试窗口）
			//
			// 点按钮**不直接开聊**。方向/职级/风格决定整场面试的走向，得先让用户选；
			// 而且中途改配置会让追问失去连贯性，所以配置只在开始前定一次。
			const [stage, setStage] = React.useState('closed');
			const [config, setConfig] = React.useState(null);

			const [pos, setPos] = React.useState(null); // null = 默认贴右下角
			const dragState = React.useRef(null);
			const boxRef = React.useRef(null);

			/** 把窗口限制在视口内 —— 拖出屏幕就找不回来了。 */
			const clamp = (x, y) => {
				const s = winSize();
				const maxX = Math.max(WIN_MARGIN, s.vw - s.w - WIN_MARGIN);
				const maxY = Math.max(WIN_MARGIN, s.vh - s.h - WIN_MARGIN);
				return {
					x: Math.min(Math.max(WIN_MARGIN, x), maxX),
					y: Math.min(Math.max(WIN_MARGIN, y), maxY),
				};
			};

			const onDragDown = (e) => {
				if (e.button !== 0) return;
				// 点标题栏上的按钮时不要启动拖拽
				if (e.target && e.target.closest && e.target.closest('button')) return;
				const box = boxRef.current ? boxRef.current.getBoundingClientRect() : { left: 0, top: 0 };
				dragState.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
				if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
			};
			const onDragMove = (e) => {
				if (!dragState.current) return;
				setPos(clamp(e.clientX - dragState.current.dx, e.clientY - dragState.current.dy));
			};
			const onDragUp = (e) => {
				if (!dragState.current) return;
				dragState.current = null;
				try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) { /* 已释放 */ }
			};

			// ---- 阶段一：收起态，右下角小按钮 ----
			if (stage === 'closed') {
				return h(
					'div',
					{ style: { pointerEvents: 'auto', position: 'fixed', right: WIN_MARGIN, bottom: WIN_MARGIN, zIndex: 40 } },
					h('button', {
						style: Object.assign({}, S.button, {
							padding: '6px 13px',
							fontSize: 12.5,
							boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
						}),
						title: '模拟面试',
						onClick: () => setStage('setup'),
					}, '模拟面试')
				);
			}

			// ---- 阶段二：设置弹窗 ----
			if (stage === 'setup') {
				return h(SetupModal, {
					initial: config || DEFAULT_CONFIG,
					// 从面试中回来改设置的，取消就退回面试；第一次进来的，取消就收起
					onCancel: () => setStage(config ? 'open' : 'closed'),
					onConfirm: (next) => { setConfig(next); setStage('open'); },
				});
			}

			// ---- 展开态：可拖拽卡片 ----
			const size = winSize();
			const positionStyle = pos === null
				? { right: WIN_MARGIN, bottom: WIN_MARGIN }
				: { left: pos.x, top: pos.y };

			return h(
				'div',
				{
					ref: boxRef,
					style: Object.assign({
						pointerEvents: 'auto',
						position: 'fixed',
						width: size.w,
						height: size.h,
						zIndex: 40,
						display: 'flex',
						flexDirection: 'column',
						borderRadius: 12,
						overflow: 'hidden',
						border: '1px solid rgba(148,163,184,0.28)',
						boxShadow: '0 18px 52px rgba(0,0,0,0.6)',
						background: '#0b1020',
					}, positionStyle),
				},
				// 标题栏 = 拖拽把手。放在这里而不是面板内部，是为了让"拖"和
				// "面板内容"职责分开。
				h(
					'div',
					{
						style: {
							display: 'flex',
							alignItems: 'center',
							gap: 8,
							padding: '7px 10px',
							flex: 'none',
							background: 'rgba(30,41,59,0.92)',
							borderBottom: '1px solid rgba(148,163,184,0.18)',
							cursor: 'grab',
							userSelect: 'none',
							touchAction: 'none',
						},
						title: '按住这里拖动窗口',
						onPointerDown: onDragDown,
						onPointerMove: onDragMove,
						onPointerUp: onDragUp,
						onPointerCancel: onDragUp,
					},
					h('span', { style: { fontSize: 12.5, fontWeight: 600, color: '#cbd5e1' } }, '模拟面试'),
					h('span', { style: { fontSize: 11, color: '#475569' } }, '⠿ 拖动'),
					h('button', {
						style: Object.assign({}, B.ghost, { marginLeft: 'auto', padding: '2px 9px', fontSize: 13 }),
						title: '收起窗口',
						onClick: () => setStage('closed'),
					}, '—')
				),
				h(
					'div',
					{ style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
					// key 用配置做标识：换了配置就 remount，对话历史跟着清空 ——
					// 同一条对话里换方向/职级会让追问失去连贯性。
					h(InterviewPanel, {
						key: configKey(config || DEFAULT_CONFIG),
						config: config || DEFAULT_CONFIG,
						onSetup: () => setStage('setup'),
					})
				)
			);
		}

		function apply(ctx) {
			console.log('[dsh-interviewer] ② apply() 被调用，开始探测槽位');

			/**
			 * 逐个尝试注入候选槽位，把每个槽位是否真的被声明记录下来。
			 * 这是唯一能在"静默失败"下拿到信息的方式。
			 */
			const probe = (name, register) => {
				try {
					ctx.slots.inject(name, () => {
						try {
							register();
							console.log('[dsh-interviewer] ✓ 槽位已声明并注入成功：' + name);
						} catch (e) {
							console.warn('[dsh-interviewer] ✗ 注入 ' + name + ' 失败：', e);
						}
					});
					console.log('[dsh-interviewer] … 已排队等待槽位：' + name);
				} catch (e) {
					console.warn('[dsh-interviewer] ✗ inject("' + name + '") 直接抛错：', e);
				}
			};

			// 只注册一个槽位：shell.overlay。
			//
			// 之前还注册过另外两个，现在都撤了：
			//   main              全屏接管中间区域。用户进得去出不来，体验也太霸道。
			//   sidebar.panellist 注册是成功的（回读确认「账面 1 条，生效 1 条」），
			//                     但侧边栏那边就是不渲染它 —— 至今没定位到原因。
			//
			// 悬浮窗口一个就够，而且不受侧边栏那个未解问题影响。
			probe('shell.overlay', () =>
				ctx.slots.register(
					{ name: 'shell.overlay', id: 'interviewer-float', order: 50 },
					FloatingInterview
				)
			);

			console.log('[dsh-interviewer] 探测完成。上面出现 ✓ 的槽位才是真实存在的。');

			// ── 回读诊断 ──
			// 注册成功不等于条目还在。SlotCore 有个"除名"机制：条目渲染时崩溃会被
			// 从它所在的 cell 里摘掉，而且是一次性的、不会恢复。那正好能解释
			// "注册成功但侧边栏什么都不显示"。
			//
			// 这里等三秒（等所有插件加载完、界面渲染过一轮），再回读注册表：
			//   entries()        —— 账面上登记了多少条
			//   entriesOfSlot()  —— 实际生效（未被除名）的有多少条
			// 两者不一致 = 被除名了。
			setTimeout(() => {
				try {
					const read = (name) => {
						const all = ctx.slots.entries(name);
						const live = ctx.slots.entriesOfSlot(name);
						console.log(
							'[dsh-interviewer] 回读 ' + name + '：账面 ' + all.length +
							' 条，生效 ' + live.length + ' 条',
							all.map((e) => e.options.id || e.options.key || '(无 id)')
						);
					};
					read('shell.overlay');
				} catch (e) {
					console.warn('[dsh-interviewer] 回读失败（可能是没有这个 API）', e);
				}
			}, 3000);
		}

		exports.apply = apply;
		exports.inject = inject;
		// 给 dev-check 用。DSH 的模块加载器只取 apply / inject，多这一个键不影响加载。
		// 之所以要开这个口子：状态条是这轮改动最核心的可视部分，而**我看不到渲染结果**
		// —— 只能让自检真的拿一份 state 调它一遍，确认它不抛错、并且真的把
		// "到上限"这个信号显示出来。
		exports.__internals = { stateStrip };
		return module.exports;
	},
});
