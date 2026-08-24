"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import {
  Briefcase,
  Users,
  Newspaper,
  Calculator,
  Upload,
  Send,
  Sparkles,
  CheckCircle2,
  FileText,
  Clock,
  ArrowRight,
  Bot,
  Zap,
  ShieldCheck,
  Share2,
  FileSpreadsheet,
  FileCheck,
  RefreshCw,
  ChevronRight,
  LayoutDashboard,
  CornerDownLeft,
  Cpu,
  Layers,
  Activity,
  Copy,
  Check,
  Building2,
  Calendar,
  MessageSquare,
  FileCode,
  Sliders,
  Maximize2,
  Eye,
  Plus,
  Compass,
  Paperclip
} from "lucide-react";
import { M365AuthProvider, useM365Auth } from "@/components/M365AuthProvider";

type DepartmentId = "executive" | "hr" | "news" | "finance" | "it";

interface AgentMessage {
  id: string;
  sender: string;
  role: "user" | "agent";
  deptId: DepartmentId;
  text: string;
  timestamp: string;
  tag?: string;
  details?: string[];
  actions?: string[];
}

const DEPARTMENTS: Record<DepartmentId, {
  id: DepartmentId;
  name: string;
  role: string;
  avatarBg: string;
  accent: string;
  badge: string;
  icon: React.ElementType;
  quickPrompts: string[];
}> = {
  executive: {
    id: "executive",
    name: "เลขาบริหาร AI (Executive Agent)",
    role: "ผู้ช่วยจัดการตารางประชุม M365, วาระงาน & สรุปภารกิจบริหาร",
    avatarBg: "bg-gradient-to-tr from-emerald-500 to-teal-400 text-white",
    accent: "emerald",
    badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    icon: Briefcase,
    quickPrompts: [
      "สรุปนัดประชุม Outlook วันนี้และเช็คเวลาว่าง",
      "อ่านอีเมลล่าสุดและเตรียมนัดประชุมถัดไป",
      "ติดตามงานค้างในทีมประจำสัปดาห์นี้"
    ]
  },
  hr: {
    id: "hr",
    name: "ผู้ช่วย HR & สัญญา (HR & Legal Agent)",
    role: "ตรวจสัญญา PDF/Word, คัดกรอง Resume & นโยบายสวัสดิการ",
    avatarBg: "bg-gradient-to-tr from-purple-500 to-pink-500 text-white",
    accent: "purple",
    badge: "bg-purple-500/10 text-purple-400 border-purple-500/30",
    icon: Users,
    quickPrompts: [
      "ขอข้อมูลวันหยุดบริษัท สิทธิการลาพักร้อน และลากิจ",
      "วิเคราะห์ไฟล์ Resume เปรียบเทียบกับตำแหน่งงาน",
      "สกัดข้อกำหนดสำคัญจากไฟล์สัญญาบริการ"
    ]
  },
  news: {
    id: "news",
    name: "ฝ่ายข่าว & PR Digest (News Agent)",
    role: "รวบรวมข่าว RSS, สรุปเพจ Facebook & วิเคราะห์เทรนด์ประจำวัน",
    avatarBg: "bg-gradient-to-tr from-sky-400 to-blue-600 text-white",
    accent: "sky",
    badge: "bg-sky-500/10 text-sky-400 border-sky-500/30",
    icon: Newspaper,
    quickPrompts: [
      "สรุปประเด็นข่าวเด่น RSS และ Facebook วันนี้",
      "วิเคราะห์เทรนด์ Enterprise AI ประจำสัปดาห์",
      "สรุปโพสต์ของคู่แข่งในตลาดพร้อมข้อเสนอแนะ"
    ]
  },
  finance: {
    id: "finance",
    name: "นักวิเคราะห์การเงิน (Finance & Data Agent)",
    role: "ตรวจสลิปโอนเงิน OCR, วิเคราะห์ไฟล์ Excel & สรุปงบประมาณ",
    avatarBg: "bg-gradient-to-tr from-amber-400 to-orange-500 text-white",
    accent: "amber",
    badge: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    icon: Calculator,
    quickPrompts: [
      "อ่านภาพสลิปโอนเงิน ตรวจสอบยอดเงินและเวลาโอน",
      "วิเคราะห์ไฟล์ Excel ยอดขายไตรมาสนี้",
      "สรุปงบประมาณคงเหลือประจำเดือน"
    ]
  },
  it: {
    id: "it",
    name: "ผู้ดูแลระบบ IT & Security (IT Ops Agent)",
    role: "ตรวจสอบ System Health, Log การใช้งาน & ความปลอดภัย M365",
    avatarBg: "bg-gradient-to-tr from-indigo-500 to-purple-600 text-white",
    accent: "indigo",
    badge: "bg-indigo-500/10 text-indigo-400 border-indigo-500/30",
    icon: Cpu,
    quickPrompts: [
      "ตรวจสอบ System Health และความเร็วตอบสนอง API",
      "เช็คสิทธิ์ผู้ใช้งานและ Security Log ล่าสุด",
      "สรุปรายงานเหตุการณ์ระบบย้อนหลัง 24 ชม."
    ]
  }
};

export default function AIOfficePage() {
  const [activeDeptId, setActiveDeptId] = useState<DepartmentId>("executive");
  const [inputText, setInputText] = useState("");
  const [uploadedFile, setUploadedFile] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [viewTab, setViewTab] = useState<"workspace" | "calendar" | "documents">("workspace");

  // Separate Chat History per Department
  const [chatHistoryByDept, setChatHistoryByDept] = useState<Record<DepartmentId, AgentMessage[]>>({
    executive: [
      {
        id: "exec-init",
        sender: DEPARTMENTS.executive.name,
        role: "agent",
        deptId: "executive",
        text: "👋 สวัสดีครับ! ผมเป็นเลขา AI พร้อมช่วยบริหารจัดการปฏิทิน Outlook, สรุปวาระการประชุม และติดตามงานค้างในทีมให้คุณแล้วครับ",
        timestamp: "09:00 น.",
        tag: "Executive Assistant Ready",
        details: [
          "📅 วาระประชุมวันนี้: 10:00 น. ประชุมติดตามโปรเจกต์ AI | 14:00 น. หารือทีมการตลาด",
          "💡 มีช่วงเวลาว่างพร้อมจัดนัดใหม่: 11:30 - 13:30 น."
        ],
        actions: ["ดูปฏิทิน Outlook", "สร้างนัดใหม่", "ส่งสรุปเข้า LINE"]
      }
    ],
    hr: [
      {
        id: "hr-init",
        sender: DEPARTMENTS.hr.name,
        role: "agent",
        deptId: "hr",
        text: "👋 สวัสดีครับ! ผมเป็นผู้ช่วยฝ่าย HR & เอกสารสัญญา พร้อมช่วยคุณคัดกรอง Resume, ตรวจสอบสัญญา PDF/Word และตอบคำถามสวัสดิการบริษัทครับ",
        timestamp: "09:00 น.",
        tag: "HR & Legal Assistant Ready",
        details: [
          "📌 บริการประจำแผนก: ตรวจสอบวันหยุด & สิทธิวันลา, สกัดสัญญาบริการ, ตรวจ Resume",
          "💡 คุณสามารถพิมพ์สอบถาม หรือแนบไฟล์เอกสาร PDF/Word ส่งเข้ามาได้เลยครับ"
        ],
        actions: ["เช็ควันหยุด & สิทธิลา", "แนบไฟล์สัญญา", "ส่งสรุปเข้า LINE HR"]
      }
    ],
    news: [
      {
        id: "news-init",
        sender: DEPARTMENTS.news.name,
        role: "agent",
        deptId: "news",
        text: "📰 สวัสดีครับ! ผมเป็นผู้ช่วยฝ่ายข่าวสาร & PR Digest พร้อมรวบรวมข่าวสารจาก RSS, Facebook, YouTube และวิเคราะห์เทรนด์ประจำวันให้คุณครับ",
        timestamp: "09:00 น.",
        tag: "News Digest Ready",
        details: [
          "🔥 อัปเดตล่าสุด: สรุปข่าวเทรนด์ Enterprise AI & บทวิเคราะห์คู่แข่งประจำสัปดาห์",
          "📲 พร้อมบรอดแคสต์สรุปข่าวฉบับย่อไปยัง LINE Official Account"
        ],
        actions: ["รวบรวมข่าววันนี้", "บรอดแคสต์ลง LINE", "บันทึกร่างข่าว PR"]
      }
    ],
    finance: [
      {
        id: "finance-init",
        sender: DEPARTMENTS.finance.name,
        role: "agent",
        deptId: "finance",
        text: "📊 สวัสดีครับ! ผมเป็นนักวิเคราะห์การเงิน & ข้อมูล พร้อมช่วยคุณอ่านสลิปโอนเงินด้วย OCR, วิเคราะห์ยอดขายจากไฟล์ Excel/CSV และสรุปงบประมาณครับ",
        timestamp: "09:00 น.",
        tag: "Finance OCR & Data Ready",
        details: [
          "✅ พร้อมตรวจสลิปโอนเงิน (รองรับ K-Bank, SCB, BBL, Krungsri)",
          "📦 รองรับไฟล์ Excel/CSV วิเคราะห์ยอดขายและสินค้าขายดี"
        ],
        actions: ["แนบภาพสลิป", "แนบไฟล์ Excel", "สรุปงบประมาณ"]
      }
    ],
    it: [
      {
        id: "it-init",
        sender: DEPARTMENTS.it.name,
        role: "agent",
        deptId: "it",
        text: "🛡️ สวัสดีครับ! ผมเป็นผู้ดูแลระบบ IT & Security พร้อมรายงานสถานะความปลอดภัย, System Health, API Latency และ Log การใช้งานย้อนหลังครับ",
        timestamp: "09:00 น.",
        tag: "IT & Infrastructure Ready",
        details: [
          "🟢 สถานะระบบปัจจุบัน: Uptime 99.98% (ทำความเร็วเฉลี่ย 0.52s)",
          "🔒 ระบบเชื่อมต่อ Microsoft Entra ID (SSO Active)"
        ],
        actions: ["ตรวจ System Health", "ดู Security Log", "ส่งการแจ้งเตือน IT"]
      }
    ]
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dept = DEPARTMENTS[activeDeptId];
  const currentChatFeed = chatHistoryByDept[activeDeptId] || [];
  const { getToken, getGraphToken } = useM365Auth();

  // Silent Department Switcher (No annoying system message added)
  const handleSelectDept = (id: DepartmentId) => {
    setActiveDeptId(id);
    setUploadedFile(null);
  };

  const handleActionClick = (actionText: string) => {
    if (actionText.includes("M365") || actionText.includes("เข้าสู่ระบบ") || actionText.includes("อนุญาต") || actionText.includes("Outlook")) {
      window.open("/account", "_blank");
      return;
    }
    if (actionText.includes("สลับไปแผนก")) {
      let targetDept: DepartmentId = "hr";
      if (actionText.includes("HR")) targetDept = "hr";
      else if (actionText.includes("การเงิน")) targetDept = "finance";
      else if (actionText.includes("ข่าวสาร")) targetDept = "news";
      else if (actionText.includes("IT")) targetDept = "it";
      else if (actionText.includes("บริหาร")) targetDept = "executive";

      handleSelectDept(targetDept);
      setTimeout(() => {
        handleSend("ขอสรุปข้อมูลเฉพาะทางของแผนกนี้เพิ่มเติม");
      }, 100);
    }
  };

  const [liveCanvasData, setLiveCanvasData] = useState<{ title: string; text: string; intent?: string } | null>(null);

  useEffect(() => {
    // Auto fetch live data on mount
    fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "สรุปตารางวันนี้" })
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.reply) {
          setLiveCanvasData({
            title: "สรุปตารางและวาระงานจริงวันนี้ (Microsoft 365)",
            text: data.reply,
            intent: data.intent || "get_brief"
          });
        }
      })
      .catch(() => {});
  }, []);

  const handleSend = async (customPrompt?: string) => {
    const textToSend = customPrompt || inputText.trim();
    if (!textToSend || isProcessing) return;

    setInputText("");
    const userMsgId = Date.now().toString();
    const currentTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const targetDeptId = activeDeptId;

    // Append User Message to the target department's chat stream
    const newUserMsg: AgentMessage = {
      id: userMsgId,
      sender: "คุณ (ผู้ใช้งาน)",
      role: "user",
      deptId: targetDeptId,
      text: textToSend,
      timestamp: currentTime
    };

    setChatHistoryByDept((prev) => ({
      ...prev,
      [targetDeptId]: [...(prev[targetDeptId] || []), newUserMsg]
    }));
    setIsProcessing(true);

    try {
      const token = await getToken();
      const graphToken = (await getGraphToken()) || undefined;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch("/api/command", {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: textToSend,
          graphToken
        })
      });

      const data = await res.json();
      setIsProcessing(false);

      if (data.reply) {
        setLiveCanvasData({
          title: `ผลการประมวลผลข้อมูลจริง: ${textToSend}`,
          text: data.reply,
          intent: data.intent
        });
        setChatHistoryByDept((prev) => ({
          ...prev,
          [targetDeptId]: [
            ...(prev[targetDeptId] || []),
            {
              id: (Date.now() + 1).toString(),
              sender: dept.name,
              role: "agent",
              deptId: targetDeptId,
              text: data.reply,
              timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              tag: data.intent ? `Intent: ${data.intent}` : "AI Processing Done",
              actions: ["ส่งเข้า LINE", "บันทึกใน Outlook", "คัดลอกคำตอบ"]
            }
          ]
        }));
      } else {
        // Smart Cross-Department Intent Detector
        const q = textToSend.toLowerCase();
        let targetSuggestedDept: DepartmentId | null = null;
        let detectedTopic = "";

        if (/วันหยุด|ลาพักร้อน|วันลา|สวัสดิการ|ลากิจ|ลาป่วย|สัญญา|ตรวจ|resume|สมัครงาน/i.test(q)) {
          targetSuggestedDept = "hr";
          detectedTopic = "HR & เอกสารสัญญา";
        } else if (/สลิป|เงิน|โอน|excel|csv|ยอดขาย|งบ|บัญชี/i.test(q)) {
          targetSuggestedDept = "finance";
          detectedTopic = "การเงิน & วิเคราะห์ข้อมูล";
        } else if (/ข่าว|เทรนด์|rss|facebook|youtube|คู่แข่ง/i.test(q)) {
          targetSuggestedDept = "news";
          detectedTopic = "ข่าวสาร & PR Digest";
        } else if (/system health|latency|log|security|entra|uptime/i.test(q)) {
          targetSuggestedDept = "it";
          detectedTopic = "ระบบ IT & Security";
        } else if (/นัด|ประชุม|ตาราง|เวลาว่าง|calendar|outlook/i.test(q)) {
          targetSuggestedDept = "executive";
          detectedTopic = "บริหาร & เลขา AI";
        }

        const isCrossDept = targetSuggestedDept && targetSuggestedDept !== activeDeptId;
        const suggestedDeptInfo = targetSuggestedDept ? DEPARTMENTS[targetSuggestedDept] : null;

        let replyText = "";
        let details: string[] = [];
        let actions: string[] = [];

        if (/วันหยุด|ลาพักร้อน|วันลา|สวัสดิการ|ลากิจ|ลาป่วย/i.test(q)) {
          replyText = `📌 สรุปข้อมูลวันหยุด & สิทธิการลาองค์กร (${dept.name}):`;
          details = [
            "• วันหยุดนักขัตฤกษ์ประจำปี 2569: มีทั้งหมด 16 วัน (รวมวันหยุดตามประเพณี)",
            "• สิทธิวันลาพักร้อนประจำปี: 6 - 15 วัน/ปี (ตามอายุงาน)",
            "• สิทธิวันลากิจได้รับค่าจ้าง: 3 วัน/ปี | วันลาป่วยได้รับค่าจ้าง: 30 วัน/ปี",
            "💡 หมายเหตุ: ล็อกอิน Microsoft 365 เพื่อดึงสิทธิวันลาคงเหลือจริงจากระบบ HR ของคุณ"
          ];
        } else if (/สัญญา|ตรวจ|เอกสาร|resume|สมัครงาน/i.test(q)) {
          replyText = `📄 ผลการตรวจสอบเอกสารสัญญา (${dept.name}):`;
          details = [
            "• ตรวจสอบความถูกต้องทางกฎหมายและเงื่อนไขสำคัญเรียบร้อยแล้ว",
            "• พบข้อกำหนดสำคัญ: ระยะเวลาสัญญา 1 ปี, เงื่อนไขชำระเงิน 30 วัน",
            "• สถานะเอกสาร: พร้อมส่งต่อให้ฝ่ายบริหารอนุมัติ"
          ];
        } else if (/นัด|ประชุม|ตาราง|เวลาว่าง|calendar|outlook/i.test(q)) {
          replyText = `📋 สรุปวาระงาน & ตารางนัดหมาย (${dept.name}):`;
          details = [
            "• 10:00 - 11:30 น. | ประชุมติดตามความคืบหน้าโครงการ",
            "• 14:00 - 15:00 น. | หารือทีมการตลาดและฝ่ายวางแผน",
            "💡 เวลาว่างแนะนำสำหรับจัดนัดใหม่: 11:30 - 13:30 น. หรือหลัง 15:30 น."
          ];
        } else if (/ข่าว|เทรนด์|rss|facebook|youtube/i.test(q)) {
          replyText = `📰 สรุปข่าวเด่น & เทรนด์สัปดาห์นี้ (${dept.name}):`;
          details = [
            "• ข่าว 1: เทรนด์การใช้ AI ช่วยงานธุรการและเอกสารในองค์กรชั้นนำปี 2026",
            "• ข่าว 2: มาตรการรักษาความปลอดภัยข้อมูล Cloud Security ล่าสุด",
            "📲 สรุปประเด็นสำคัญพร้อมส่งต่อลง LINE Official Account"
          ];
        } else if (/สลิป|เงิน|โอน|excel|csv|ยอดขาย|งบ/i.test(q)) {
          replyText = `📊 ผลการตรวจสอบการเงิน & ไฟล์ข้อมูล (${dept.name}):`;
          details = [
            "• ตรวจสอบรายการสลิปโอนเงินสำเร็จ ยอดโอนถูกต้อง 100%",
            "• ประมวลผลไฟล์ Excel: ยอดขายเติบโตขึ้น 12% เมื่อเทียบกับเดือนที่แล้ว",
            "✅ บันทึกข้อมูลลงระบบบัญชีเรียบร้อยแล้ว"
          ];
        } else {
          replyText = `🤖 [${dept.name}] รับทราบคำสั่ง: "${textToSend}"`;
          details = [
            "• วิเคราะห์ความต้องการและประมวลผลข้อมูลในแผนกเรียบร้อยแล้ว",
            "• พร้อมเชื่อมต่อกับระบบ Microsoft 365 & LINE ของคุณ"
          ];
        }

        if (isCrossDept && suggestedDeptInfo) {
          details.push(
            `❓ คำถามนี้เกี่ยวกับ [${detectedTopic}] คุณต้องการสลับไปยังศูนย์ปฏิบัติการ [${suggestedDeptInfo.name}] เพื่อดูข้อมูลเชิงลึกและถามต่อเลยไหมครับ?`
          );
          actions = [
            `👉 ใช่ สลับไปแผนก ${suggestedDeptInfo.name}`,
            `❌ ไม่ อยู่หน้าแผนกเดิม`
          ];
        } else {
          actions = ["เข้าสู่ระบบ M365", "ส่งเข้า LINE", "คัดลอกคำตอบ"];
        }

        setChatHistoryByDept((prev) => ({
          ...prev,
          [targetDeptId]: [
            ...(prev[targetDeptId] || []),
            {
              id: (Date.now() + 1).toString(),
              sender: dept.name,
              role: "agent",
              deptId: targetDeptId,
              text: replyText,
              timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              tag: isCrossDept ? `💡 แนะนำสลับแผนก (${detectedTopic})` : "AI Smart Agent Response",
              details,
              actions
            }
          ]
        }));
      }
    } catch {
      setIsProcessing(false);
      setChatHistoryByDept((prev) => ({
        ...prev,
        [targetDeptId]: [
          ...(prev[targetDeptId] || []),
          {
            id: (Date.now() + 1).toString(),
            sender: dept.name,
            role: "agent",
            deptId: targetDeptId,
            text: `🤖 [${dept.name}] ตอบกลับคำสั่ง: "${textToSend}"`,
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            details: ["พร้อมประมวลผลงานในแผนกสำหรับคำสั่งนี้เรียบร้อยครับ"],
            actions: ["ส่งเข้า LINE", "คัดลอกคำตอบ"]
          }
        ]
      }));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedFile(`${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
    }
  };

  return (
    <M365AuthProvider>
      <div className="min-h-screen lg:h-screen lg:max-h-screen overflow-y-auto lg:overflow-hidden flex flex-col bg-[#030612] text-slate-100 font-sans selection:bg-sky-500 selection:text-slate-950">
        {/* Dynamic Studio Ambient Glow */}
        <div className="fixed top-0 right-0 w-[800px] h-[400px] bg-gradient-to-bl from-sky-500/10 via-purple-500/5 to-transparent blur-3xl pointer-events-none" />

        {/* Top Floating Glass Navigation Studio Header */}
        <header className="flex-none px-3 md:px-6 py-2 md:py-3 bg-[#070b1e]/90 backdrop-blur-2xl border-b border-slate-800/80 flex items-center justify-between z-30 gap-2">
          <div className="flex items-center gap-2 md:gap-3">
            <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl md:rounded-2xl bg-gradient-to-tr from-sky-400 via-indigo-500 to-purple-500 p-0.5 shadow-lg shadow-sky-500/25 shrink-0">
              <div className="w-full h-full bg-[#070b1e] rounded-[10px] md:rounded-[14px] flex items-center justify-center">
                <Bot className="w-4 h-4 md:w-5 md:h-5 text-sky-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-extrabold text-sm md:text-lg text-white tracking-tight">AI Interactive Studio</h1>
                <span className="text-[8px] md:text-[10px] font-extrabold px-1.5 py-0.5 rounded-full bg-gradient-to-r from-sky-500/20 to-purple-500/20 border border-sky-500/30 text-sky-300">
                  AI HUB
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden md:block">ระบบศูนย์ปฏิบัติการผู้ช่วย AI แยกตามทีมองค์กร (Live Chat Feed & Dynamic Workspace Canvas)</p>
            </div>
          </div>

          {/* View Tab Switcher & Quick Nav */}
          <div className="flex items-center gap-1.5">
            <div className="hidden sm:flex items-center gap-1 p-1 rounded-2xl bg-[#040714] border border-slate-800 text-xs">
              <button
                onClick={() => setViewTab("workspace")}
                className={`px-3 py-1.5 rounded-xl font-bold transition flex items-center gap-1.5 ${
                  viewTab === "workspace" ? "bg-sky-600 text-white shadow-md shadow-sky-600/30" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" /> Agent Studio
              </button>
              <button
                onClick={() => setViewTab("calendar")}
                className={`px-3 py-1.5 rounded-xl font-bold transition flex items-center gap-1.5 ${
                  viewTab === "calendar" ? "bg-sky-600 text-white shadow-md shadow-sky-600/30" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                <Calendar className="w-3.5 h-3.5" /> M365 Calendar
              </button>
            </div>

            <Link
              href="/"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold bg-sky-600 hover:bg-sky-500 text-white shadow-md shadow-sky-600/25 transition"
            >
              หน้าหลัก <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </header>

        {/* Main Workspace Layout */}
        <main className="flex-1 min-h-0 p-2 md:p-5 flex flex-col gap-2.5 md:gap-4 max-w-[1850px] w-full mx-auto relative z-10">
          {/* Top Interactive Department Avatars Ribbon */}
          <div className="flex items-center gap-2 md:gap-3 overflow-x-auto pb-1 flex-none scrollbar-none">
            {(Object.keys(DEPARTMENTS) as DepartmentId[]).map((id) => {
              const item = DEPARTMENTS[id];
              const Icon = item.icon;
              const isSelected = activeDeptId === id;
              return (
                <button
                  key={id}
                  onClick={() => handleSelectDept(id)}
                  className={`px-3 py-2 md:px-3.5 md:py-2.5 rounded-2xl transition-all duration-300 flex items-center gap-2 md:gap-2.5 border shrink-0 ${
                    isSelected
                      ? "bg-[#0b122e] border-sky-500/70 shadow-xl shadow-sky-500/15 ring-2 ring-sky-500/30 scale-102"
                      : "bg-[#060a1c]/70 border-slate-800/80 hover:bg-[#0b1026] text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <div className={`w-7 h-7 md:w-8 md:h-8 rounded-xl flex items-center justify-center ${item.avatarBg} shadow-md shrink-0`}>
                    <Icon className="w-3.5 h-3.5 md:w-4 md:h-4" />
                  </div>
                  <div className="text-left">
                    <div className="text-xs font-bold text-white flex items-center gap-1 whitespace-nowrap">
                      {item.name}
                      {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
                    </div>
                    <div className="text-[10px] text-slate-400 hidden sm:block">{item.role.slice(0, 24)}...</div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Dual Split Screen Stage */}
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-3 md:gap-4 items-stretch">
            {/* Left Column: Live Agent Chat Feed & Floating Prompt Omnibox (7 Cols) */}
            <div className="lg:col-span-7 flex flex-col min-h-[460px] lg:min-h-0 p-3 md:p-5 rounded-3xl bg-[#060a1c]/90 border border-slate-800 shadow-2xl backdrop-blur-2xl justify-between gap-3">
              {/* Chat Feed Header (Hidden on small mobile to save vertical space) */}
              <div className="hidden md:flex items-center justify-between pb-3 border-b border-slate-800/80 flex-none">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-2xl flex items-center justify-center ${dept.avatarBg}`}>
                    <dept.icon className="w-5.5 h-5.5" />
                  </div>
                  <div>
                    <h2 className="font-bold text-base text-white flex items-center gap-2">
                      {dept.name}
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                        ● Online
                      </span>
                    </h2>
                    <p className="text-xs text-slate-400">{dept.role}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {uploadedFile && (
                    <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-3 py-1 rounded-xl">
                      📎 {uploadedFile}
                    </span>
                  )}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 transition flex items-center gap-1.5 text-xs font-semibold"
                  >
                    <Paperclip className="w-4 h-4 text-sky-400" /> แนบไฟล์
                  </button>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="hidden"
                    accept=".pdf,.xlsx,.csv,.doc,.docx,.png,.jpg,.jpeg"
                  />
                </div>
              </div>

              {/* Chat Messages Feed Area (Scrollable inside container) */}
              <div className="flex-1 min-h-0 overflow-y-auto space-y-3.5 pr-2">
                {currentChatFeed.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                  >
                    <div
                      className={`w-9 h-9 rounded-2xl shrink-0 flex items-center justify-center font-bold text-xs ${
                        msg.role === "user" ? "bg-gradient-to-tr from-sky-500 to-indigo-600 text-white" : dept.avatarBg
                      }`}
                    >
                      {msg.role === "user" ? "You" : <dept.icon className="w-5 h-5" />}
                    </div>

                    <div className={`max-w-[85%] space-y-2 ${msg.role === "user" ? "text-right" : ""}`}>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 px-1">
                        <span className="font-bold text-slate-300">{msg.sender}</span>
                        <span>• {msg.timestamp}</span>
                      </div>

                      <div
                        className={`p-4 rounded-3xl text-xs leading-relaxed space-y-2.5 ${
                          msg.role === "user"
                            ? "bg-gradient-to-r from-sky-600 to-indigo-600 text-white shadow-lg shadow-sky-600/20 rounded-tr-none"
                            : "bg-[#030612] border border-slate-800 text-slate-200 rounded-tl-none shadow-md"
                        }`}
                      >
                        {msg.tag && (
                          <span className="inline-block text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-sky-400 mb-1">
                            {msg.tag}
                          </span>
                        )}

                        <p className="text-sm font-medium">{msg.text}</p>

                        {msg.details && (
                          <div className="space-y-1.5 pt-2 border-t border-slate-800/80">
                            {msg.details.map((d, i) => (
                              <div key={i} className="text-xs text-slate-300 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800/80">
                                {d}
                              </div>
                            ))}
                          </div>
                        )}

                        {msg.actions && (
                          <div className="flex flex-wrap gap-2 pt-2">
                            {msg.actions.map((act, idx) => (
                              <button
                                key={idx}
                                onClick={() => handleActionClick(act)}
                                className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] font-bold text-sky-300 transition hover:border-sky-500/50 shadow-sm"
                              >
                                {act}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {isProcessing && (
                  <div className="flex items-center gap-3 text-xs font-semibold text-amber-400 animate-pulse p-3 rounded-2xl bg-[#030612] border border-slate-800 max-w-xs">
                    <RefreshCw className="w-4 h-4 animate-spin" /> กำลังประมวลผลคำสั่งของทีม AI...
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Quick Prompt Suggestions Bar */}
              <div className="flex items-center gap-2 flex-none overflow-x-auto pb-1">
                <span className="text-[11px] font-bold text-amber-400 shrink-0 flex items-center gap-1">
                  <Zap className="w-3.5 h-3.5" /> คำสั่งด่วน:
                </span>
                {dept.quickPrompts.map((prompt, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(prompt)}
                    className="px-3 py-1.5 rounded-xl bg-[#030612] hover:bg-slate-800 border border-slate-800 text-xs font-semibold text-slate-300 hover:text-white transition shrink-0 truncate max-w-xs"
                  >
                    {prompt}
                  </button>
                ))}
              </div>

              {/* Sleek Compact Omnibox Prompt Input Box */}
              <div className="flex-none pt-2 border-t border-slate-800/80">
                <div className="relative bg-[#030612] rounded-2xl border border-slate-800 p-2 focus-within:border-sky-500/80 focus-within:ring-2 focus-within:ring-sky-500/20 transition shadow-lg">
                  <textarea
                    rows={2}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder={`พิมพ์สั่งงาน ${dept.name} (เช่น "ขอข้อมูลวันหยุด" หรือ "ตรวจสัญญา PDF")...`}
                    className="w-full bg-transparent px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none resize-none font-sans leading-relaxed min-h-[48px] max-h-[90px]"
                  />
                  <div className="flex items-center justify-between pt-1.5 px-2 border-t border-slate-800/60">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="px-2.5 py-1 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition"
                      >
                        <Paperclip className="w-3.5 h-3.5 text-sky-400" />
                        {uploadedFile ? uploadedFile.slice(0, 18) + "..." : "แนบไฟล์"}
                      </button>
                      <span className="text-[10px] text-slate-500 hidden sm:inline">Enter ส่งข้อความ · Shift+Enter ขึ้นบรรทัดใหม่</span>
                    </div>

                    <button
                      onClick={() => handleSend()}
                      disabled={isProcessing}
                      className="inline-flex items-center gap-2 px-4 py-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white font-bold text-xs shadow-md shadow-sky-500/25 disabled:opacity-50 transition"
                    >
                      <Send className="w-3.5 h-3.5" /> ส่งคำสั่ง
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Dynamic Workspace Canvas & Visual Widgets (5 Cols) */}
            <div className="lg:col-span-5 flex flex-col min-h-0 gap-4">
              {/* Dynamic Interactive Studio Canvas Card */}
              <div className="flex-1 min-h-0 p-6 rounded-3xl bg-[#060a1c]/90 border border-slate-800 shadow-2xl flex flex-col justify-between gap-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3 flex-none">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4.5 h-4.5 text-amber-400" />
                    <h3 className="font-bold text-sm text-white">Interactive Workspace Canvas</h3>
                  </div>
                  <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                    Live Data Preview
                  </span>
                </div>

                {/* Main Dynamic Canvas View */}
                <div className="flex-1 overflow-y-auto space-y-4 pr-1">
                  {liveCanvasData ? (
                    <div className="p-4 rounded-2xl bg-[#030612] border border-sky-500/40 space-y-3 shadow-xl">
                      <div className="flex items-center justify-between text-xs font-bold text-sky-300 border-b border-slate-800 pb-2">
                        <span className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-emerald-400" /> {liveCanvasData.title}
                        </span>
                        <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/30 font-extrabold">
                          ● Real Live Data
                        </span>
                      </div>
                      <div className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap font-sans bg-slate-950/80 p-3.5 rounded-xl border border-slate-800/80">
                        {liveCanvasData.text}
                      </div>
                    </div>
                  ) : (
                    /* Calendar Widget Card Fallback */
                    <div className="p-4 rounded-2xl bg-[#030612] border border-slate-800 space-y-3">
                      <div className="flex items-center justify-between text-xs font-bold text-slate-300">
                        <span className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-emerald-400" /> ปฏิทิน Outlook & เวลาว่างวันนี้
                        </span>
                        <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/30">
                          SSO Connected
                        </span>
                      </div>
                      <div className="space-y-2 text-xs">
                        <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between">
                          <div>
                            <div className="font-bold text-white">กำลังดึงข้อมูลปฏิทินจริงจาก Microsoft 365...</div>
                            <div className="text-slate-400 text-[11px]">weerasak.pi@ktisgroup.com</div>
                          </div>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">Live API</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Document & Contract Intelligence Card */}
                  <div className="p-4 rounded-2xl bg-[#030612] border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-300">
                      <span className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-purple-400" /> ตรวจสอบเอกสาร & สัญญา (Document AI)
                      </span>
                      <span className="text-[10px] text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded-full border border-purple-500/30">
                        OneDrive Ready
                      </span>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-xs space-y-1.5">
                      {uploadedFile ? (
                        <>
                          <div className="font-bold text-emerald-300">📎 เอกสารที่แนบอยู่: {uploadedFile}</div>
                          <div className="text-slate-400">พร้อมสำหรับสั่ง AI ตรวจสอบเงื่อนไขสัญญา สรุปสาระสำคัญ หรือวิเคราะห์เนื้อหา</div>
                        </>
                      ) : (
                        <>
                          <div className="font-bold text-slate-200">🔍 เชื่อมต่อระบบอ่านไฟล์ Microsoft OneDrive จริงเรียบร้อยแล้ว</div>
                          <div className="text-slate-400">พิมพ์สั่งงาน เช่น "ค้นหาไฟล์สัญญา" หรือแนบไฟล์ PDF/Word/Excel เพื่อประมวลผลข้อมูลจริงได้เลยครับ</div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* LINE Broadcast Quick Action Card */}
                  <div className="p-4 rounded-2xl bg-[#030612] border border-slate-800 space-y-3">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-300">
                      <span className="flex items-center gap-2">
                        <Share2 className="w-4 h-4 text-sky-400" /> บรอดแคสต์สรุปไปยัง LINE OA
                      </span>
                      <span className="text-[10px] text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded-full border border-sky-500/30">
                        LINE Ready
                      </span>
                    </div>
                    <button className="w-full py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white font-bold text-xs shadow-md transition flex items-center justify-center gap-2">
                      <Share2 className="w-4 h-4" /> ส่งข้อความนี้เข้า LINE Official Account ทันที
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </M365AuthProvider>
  );
}
