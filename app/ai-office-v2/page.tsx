"use client";

import React, { useState, useRef } from "react";
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
  Sparkle,
  MessageSquare,
  FileCode,
  Sliders,
  Paperclip,
  Wand2,
  ShieldAlert,
  Flame,
  Globe2
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

interface Department {
  id: DepartmentId;
  name: string;
  code: string;
  role: string;
  icon: React.ElementType;
  gradient: string;
  badgeBg: string;
  badgeText: string;
  glowShadow: string;
  activeBorder: string;
  presets: { label: string; prompt: string; icon: React.ElementType }[];
  sampleOutput: {
    title: string;
    tag: string;
    details: { icon: string; text: string; highlight?: boolean; warning?: boolean }[];
    actions: string[];
  };
}

const DEPARTMENTS: Record<DepartmentId, Department> = {
  executive: {
    id: "executive",
    name: "ฝ่ายบริหาร & เลขา AI",
    code: "EXECUTIVE AI",
    role: "จัดการปฏิทิน Outlook, สรุปนัดประชุม & ติดตามวาระงานบริหาร",
    icon: Briefcase,
    gradient: "from-emerald-400 via-teal-400 to-cyan-500",
    badgeBg: "bg-emerald-500/10 border-emerald-500/30",
    badgeText: "text-emerald-400",
    glowShadow: "shadow-emerald-500/20",
    activeBorder: "border-emerald-500/70 ring-emerald-500/30",
    presets: [
      { label: "สรุปนัดประชุมวันนี้", prompt: "ดึงปฏิทิน Outlook สรุปนัดประชุมวันนี้และวิเคราะห์เวลาว่าง", icon: Clock },
      { label: "เตรียมนัดประชุมถัดไป", prompt: "อ่านเอกสารแนบและประวัติอีเมลเพื่อสรุปประเด็นสำหรับนัดถัดไป", icon: Sparkles },
      { label: "ติดตามงานค้างทีม", prompt: "ตรวจสอบงานที่ยังไม่เสร็จจากอีเมลและแจ้งเตือนผู้รับผิดชอบ", icon: CheckCircle2 }
    ],
    sampleOutput: {
      title: "📋 สรุปวาระการประชุม & เวลาว่างวันนี้ (Executive Agent)",
      tag: "Microsoft 365 Connected",
      details: [
        { icon: "📅", text: "10:00 - 11:30 น. | ประชุมติดตามความคืบหน้าโปรเจกต์ AI (ห้องประชุม 2)" },
        { icon: "📅", text: "14:00 - 15:00 น. | หารือทีมการตลาด M365 Integration" },
        { icon: "💡", text: "ช่วงเวลาว่างแนะนำสำหรับนัดหมายใหม่: 11:30 - 13:30 น. หรือ 15:30 น. เป็นต้นไป", highlight: true },
        { icon: "⚠️", text: "งานค้างที่ต้องติดตาม: สรุปรายงาน Q3 จากฝ่ายบัญชี (เกินกำหนด 1 วัน)", warning: true }
      ],
      actions: ["จองเวลาใน Outlook", "ส่งสรุปเข้า LINE", "สร้างรายการงานค้าง"]
    }
  },
  hr: {
    id: "hr",
    name: "ฝ่าย HR & เอกสารสัญญา",
    code: "HR & LEGAL AI",
    role: "คัดกรอง Resume, ตรวจสัญญา PDF/Word & นโยบายสวัสดิการ",
    icon: Users,
    gradient: "from-purple-400 via-pink-500 to-rose-500",
    badgeBg: "bg-purple-500/10 border-purple-500/30",
    badgeText: "text-purple-400",
    glowShadow: "shadow-purple-500/20",
    activeBorder: "border-purple-500/70 ring-purple-500/30",
    presets: [
      { label: "ตรวจสอบวันหยุด & สิทธิลา", prompt: "ขอสรุปวันหยุดบริษัท สิทธิวันลาพักร้อน ลากิจ และวันลาป่วยประจำปี", icon: ShieldCheck },
      { label: "คัดกรองไฟล์ Resume", prompt: "วิเคราะห์ไฟล์ Resume เปรียบเทียบกับความต้องการตำแหน่ง Senior Developer", icon: FileText },
      { label: "สกัดข้อสัญญาบริการ", prompt: "อ่านเอกสารสัญญาบริการ ค้นหาข้อกำหนดเรื่องการรับประกันและค่าปรับ", icon: FileCheck }
    ],
    sampleOutput: {
      title: "📄 ผลการวิเคราะห์สัญญาบริการ & ข้อควรระวัง (HR/Legal Agent)",
      tag: "Document Intelligence OCR",
      details: [
        { icon: "📌", text: "คู่สัญญาหลัก: บริษัท KTIS จำกัด (ผู้ว่าจ้าง) กับ บริษัท เทคโนโลยี จำกัด (ผู้รับจ้าง)" },
        { icon: "⏳", text: "ระยะเวลาสัญญา: 1 กันยายน 2026 - 31 สิงหาคม 2027 (รวมระยะเวลา 1 ปี)" },
        { icon: "⚠️", text: "ข้อควรระวังเพิ่มเติม: มีเงื่อนไขค่าปรับล่าช้า 0.1% ต่อวัน หากส่งมอบงานเกินกำหนด", warning: true },
        { icon: "✅", text: "คะแนนความสมบูรณ์ของเอกสารสัญญา: 95% (ขาดเอกสารแนบท้าย 2)", highlight: true }
      ],
      actions: ["ส่งต่อทีมกฎหมาย", "ส่งสรุปเข้า LINE HR", "ดาวน์โหลด PDF สรุป"]
    }
  },
  news: {
    id: "news",
    name: "ฝ่ายข่าวสาร & PR Digest",
    code: "NEWS & PR AI",
    role: "รวบรวมข่าว RSS, สรุปเพจ Facebook & วิเคราะห์เทรนด์ประจำวัน",
    icon: Newspaper,
    gradient: "from-sky-400 via-blue-500 to-indigo-500",
    badgeBg: "bg-sky-500/10 border-sky-500/30",
    badgeText: "text-sky-400",
    glowShadow: "shadow-sky-500/20",
    activeBorder: "border-sky-500/70 ring-sky-500/30",
    presets: [
      { label: "รวบรวมข่าวประจำวัน", prompt: "ดึงข่าวล่าสุดจาก RSS และเพจ Facebook สรุปประเด็นเด่น 3 ข่าวแรก", icon: Newspaper },
      { label: "ติดตามเทรนด์ AI & IT", prompt: "วิเคราะห์ความเคลื่อนไหววงการเทคโนโลยีและปัญญาประดิษฐ์สัปดาห์นี้", icon: Zap },
      { label: "สรุปข่าวแข่งขันคู่แข่ง", prompt: "ตรวจสอบโพสต์และข่าวสารของคู่แข่งในตลาดพร้อมบทวิเคราะห์", icon: RefreshCw }
    ],
    sampleOutput: {
      title: "📰 สรุปข่าวเด่นประจำวัน & บทวิเคราะห์เทรนด์ (News Agent)",
      tag: "Multi-Channel RSS Reader",
      details: [
        { icon: "🔥", text: "ข่าวเด่น 1: การเติบโตของการนำ Enterprise AI Workflows มาใช้ในองค์กรปี 2026" },
        { icon: "💡", text: "ข่าวเด่น 2: อัปเดตมาตรการใหม่ด้านการรักษาความปลอดภัยข้อมูลบนระบบ Cloud" },
        { icon: "📈", text: "สรุปภาพรวม: ความต้องการระบบ AI ช่วยงานเอกสารเพิ่มขึ้น 40% ในไตรมาสนี้", highlight: true },
        { icon: "📲", text: "พร้อมสำหรับการกดส่งสรุปฉบับย่อไปยัง LINE Official Account ทันที" }
      ],
      actions: ["บรอดแคสต์ลง LINE", "บันทึกร่างข่าว PR", "แชร์ลิงก์ข่าว"]
    }
  },
  finance: {
    id: "finance",
    name: "ฝ่ายการเงิน & วิเคราะห์ข้อมูล",
    code: "FINANCE & DATA",
    role: "ตรวจสลิปโอนเงิน OCR, วิเคราะห์ไฟล์ Excel/CSV & สรุปงบ",
    icon: Calculator,
    gradient: "from-amber-400 via-orange-500 to-yellow-500",
    badgeBg: "bg-amber-500/10 border-amber-500/30",
    badgeText: "text-amber-400",
    glowShadow: "shadow-amber-500/20",
    activeBorder: "border-amber-500/70 ring-amber-500/30",
    presets: [
      { label: "ตรวจสอบสลิปโอนเงิน", prompt: "อ่านภาพสลิปตรวจสอบยอดเงิน 1,500 บาท และเวลาโอนจากธนาคาร", icon: FileCheck },
      { label: "วิเคราะห์ไฟล์ยอดขาย (Excel)", prompt: "ประมวลผลไฟล์ Excel ยอดขายไตรมาสนี้ ค้นหาสินค้าขายดีที่สุด", icon: FileSpreadsheet },
      { label: "สรุปงบประมาณคงเหลือ", prompt: "สรุปยอดรายรับ-รายจ่ายเดือนนี้พร้อมเปรียบเทียบกับงบที่ตั้งไว้", icon: Calculator }
    ],
    sampleOutput: {
      title: "📊 ผลการวิเคราะห์ไฟล์ยอดขาย & สลิปโอนเงิน (Finance Agent)",
      tag: "Data Analytics & Slip OCR",
      details: [
        { icon: "✅", text: "ผลตรวจสลิป: โอนเงินสำเร็จ 1,500.00 บาท (ผ่าน K-Bank เวลา 08:45 น.)", highlight: true },
        { icon: "📦", text: "ยอดขายรวมตามไฟล์ Excel: 485,000 บาท (เติบโตขึ้น 12% จากเดือนที่แล้ว)" },
        { icon: "⭐", text: "สินค้าขายดีอันดับ 1: แพ็กเกจ AI Assistant Enterprise (คิดเป็น 42% ของยอดขายรวม)" },
        { icon: "⚠️", text: "หมายเหตุ: พบรายการเบิกจ่ายรอนุมัติ 3 รายการ", warning: true }
      ],
      actions: ["บันทึกลง Excel", "ส่งใบเสร็จให้ลูกค้า", "ส่งแจ้งเตือนฝ่ายบัญชี"]
    }
  },
  it: {
    id: "it",
    name: "ฝ่ายระบบ IT & Security",
    code: "IT & SECURITY",
    role: "ตรวจสอบ System Health, Log การใช้งาน & ควบคุมสิทธิ์เข้าถึง",
    icon: Cpu,
    gradient: "from-indigo-400 via-purple-500 to-pink-500",
    badgeBg: "bg-indigo-500/10 border-indigo-500/30",
    badgeText: "text-indigo-400",
    glowShadow: "shadow-indigo-500/20",
    activeBorder: "border-indigo-500/70 ring-indigo-500/30",
    presets: [
      { label: "ตรวจสอบ System Health", prompt: "ตรวจสอบสถานะการทำงานของ API, Database และ LLM Chain ปัจจุบัน", icon: Activity },
      { label: "เช็คสิทธิ์ผู้ใช้งาน", prompt: "ตรวจสอบรายชื่อผู้ใช้งานที่มีสิทธิ์เข้าถึงหน้าระบบและ Log ล่าสุด", icon: ShieldCheck },
      { label: "สรุปเหตุการณ์ระบบประจำวัน", prompt: "สรุปรายงาน Log และสถิติคำสั่งซื้อการใช้งานย้อนหลัง 24 ชม.", icon: Layers }
    ],
    sampleOutput: {
      title: "🛡️ รายงานสถานะความปลอดภัย & System Health (IT Agent)",
      tag: "Security & Infrastructure",
      details: [
        { icon: "🟢", text: "สถานะเซิร์ฟเวอร์หลัก: ทำงานปกติ 100% (Uptime 99.98%)", highlight: true },
        { icon: "⚡", text: "ความเร็วตอบสนองเฉลี่ย LLM: 0.52 วินาที (ผ่าน Groq / Qwen / Gemini)" },
        { icon: "🔒", text: "สิทธิ์ความปลอดภัย: เชื่อมต่อ Microsoft Entra ID (SSO Active)" },
        { icon: "📊", text: "ปริมาณการประมวลผลคำสั่งย้อนหลัง 24 ชม.: 1,420 รายการ" }
      ],
      actions: ["เปิดดู System Log", "ส่งการแจ้งเตือน IT", "ส่งออกข้อมูล Log"]
    }
  }
};

export default function LuxuryAIOfficeV2Page() {
  const [activeDeptId, setActiveDeptId] = useState<DepartmentId>("executive");
  const [promptInput, setPromptInput] = useState("");
  const [uploadedFile, setUploadedFile] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeStep, setActiveStep] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  const [outputResult, setOutputResult] = useState<typeof DEPARTMENTS.executive.sampleOutput | null>(
    DEPARTMENTS.executive.sampleOutput
  );

  // Chat History Stream per Department for Middle Box
  const [chatHistoryByDept, setChatHistoryByDept] = useState<Record<DepartmentId, AgentMessage[]>>({
    executive: [
      {
        id: "exec-init",
        sender: DEPARTMENTS.executive.name,
        role: "agent",
        deptId: "executive",
        text: "👋 สวัสดีครับ! ผมเป็นเลขา AI พร้อมช่วยบริหารจัดการปฏิทิน Outlook, สรุปวาระการประชุม และติดตามงานค้างให้คุณแล้วครับ",
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
        text: "👋 สวัสดีครับ! ผมเป็นผู้ช่วย HR & เอกสารสัญญา พร้อมช่วยคัดกรอง Resume, ตรวจสัญญา PDF/Word และตอบสวัสดิการบริษัทครับ",
        timestamp: "09:00 น.",
        tag: "HR & Legal Ready",
        details: [
          "📌 สิทธิวันลาพักร้อนคงเหลือ: 8 วัน | วันลากิจคงเหลือ: 3 วัน",
          "📄 พร้อมตรวจวิเคราะห์สัญญาบริการและคัดกรอง Resume"
        ],
        actions: ["เช็คสิทธิการลา", "แนบไฟล์สัญญา", "ส่งเข้า LINE HR"]
      }
    ],
    news: [
      {
        id: "news-init",
        sender: DEPARTMENTS.news.name,
        role: "agent",
        deptId: "news",
        text: "📰 สวัสดีครับ! ผมเป็นผู้ช่วยฝ่ายข่าวสาร & PR Digest พร้อมสรุปข่าว RSS, Facebook และวิเคราะห์เทรนด์ประจำวันให้คุณครับ",
        timestamp: "09:00 น.",
        tag: "News Digest Ready",
        details: [
          "🔥 สรุปข่าวเด่น AI & Tech Trends สัปดาห์นี้",
          "📲 พร้อมบรอดแคสต์ลง LINE Official Account"
        ],
        actions: ["รวบรวมข่าววันนี้", "บรอดแคสต์ลง LINE"]
      }
    ],
    finance: [
      {
        id: "finance-init",
        sender: DEPARTMENTS.finance.name,
        role: "agent",
        deptId: "finance",
        text: "📊 สวัสดีครับ! ผมเป็นนักวิเคราะห์การเงิน & ข้อมูล พร้อมตรวจสลิปโอนเงิน OCR และประมวลผลไฟล์ Excel/CSV ยอดขายครับ",
        timestamp: "09:00 น.",
        tag: "Finance OCR Ready",
        details: [
          "✅ ตรวจสลิปโอนเงิน OCR แม่นยำ 100%",
          "📦 วิเคราะห์ยอดขายและสินค้าขายดีจากไฟล์ Excel"
        ],
        actions: ["ตรวจสลิปโอนเงิน", "แนบไฟล์ Excel"]
      }
    ],
    it: [
      {
        id: "it-init",
        sender: DEPARTMENTS.it.name,
        role: "agent",
        deptId: "it",
        text: "🛡️ สวัสดีครับ! ผมเป็นผู้ดูแลระบบ IT & Security พร้อมรายงาน System Health, Latency และ Security Log ล่าสุดครับ",
        timestamp: "09:00 น.",
        tag: "IT Ops Ready",
        details: [
          "🟢 สถานะระบบปัจจุบัน: Uptime 99.98%",
          "🔒 สิทธิ์ความปลอดภัย: SSO Active (Entra ID)"
        ],
        actions: ["ตรวจ System Health", "ดู Security Log"]
      }
    ]
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dept = DEPARTMENTS[activeDeptId];
  const currentChatFeed = chatHistoryByDept[activeDeptId] || [];
  const { getToken, getGraphToken } = useM365Auth();

  const handleSelectDept = (id: DepartmentId) => {
    setActiveDeptId(id);
    setOutputResult(DEPARTMENTS[id].sampleOutput);
    setPromptInput("");
    setUploadedFile(null);
  };

  const handleRunPreset = (presetPrompt: string) => {
    setPromptInput(presetPrompt);
    runAgentSimulation(presetPrompt);
  };

  const handleSend = () => {
    const textToSend = promptInput.trim() || "ช่วยสรุปข้อมูลและวิเคราะห์งานในแผนกนี้";
    setPromptInput("");
    runAgentSimulation(textToSend);
  };

  const copyResponse = () => {
    if (!outputResult) return;
    const textToCopy = `${outputResult.title}\n\n${outputResult.details.map((d) => `${d.icon} ${d.text}`).join("\n")}`;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleActionClick = (actionText: string) => {
    if (actionText.includes("M365") || actionText.includes("เข้าสู่ระบบ") || actionText.includes("อนุญาต")) {
      window.open("/account", "_blank");
      return;
    }
    if (actionText.includes("สลับไปแผนก")) {
      let targetDept: DepartmentId = "hr";
      if (actionText.includes("HR") || actionText.includes("สัญญา")) targetDept = "hr";
      else if (actionText.includes("การเงิน")) targetDept = "finance";
      else if (actionText.includes("ข่าวสาร")) targetDept = "news";
      else if (actionText.includes("IT")) targetDept = "it";
      else if (actionText.includes("บริหาร")) targetDept = "executive";

      handleSelectDept(targetDept);
      setTimeout(() => {
        runAgentSimulation("ขอรายละเอียดและดำเนินการเรื่องนี้ต่อ");
      }, 100);
    }
  };

  const runAgentSimulation = async (text: string) => {
    setIsProcessing(true);
    setActiveStep(1);

    const targetDeptId = activeDeptId;
    const currentTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    // Append User Prompt to Chat Feed
    const newUserMsg: AgentMessage = {
      id: Date.now().toString(),
      sender: "คุณ (ผู้ใช้งาน)",
      role: "user",
      deptId: targetDeptId,
      text,
      timestamp: currentTime
    };

    setChatHistoryByDept((prev) => ({
      ...prev,
      [targetDeptId]: [...(prev[targetDeptId] || []), newUserMsg]
    }));

    const stepTimer1 = setTimeout(() => setActiveStep(2), 350);
    const stepTimer2 = setTimeout(() => setActiveStep(3), 750);

    try {
      const token = await getToken();
      const graphToken = (await getGraphToken()) || undefined;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch("/api/command", {
        method: "POST",
        headers,
        body: JSON.stringify({
          text,
          graphToken
        })
      });

      const data = await res.json();
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      setActiveStep(4);
      setIsProcessing(false);

      if (data.reply) {
        const lines = data.reply
          .split("\n")
          .map((l: string) => l.trim())
          .filter(Boolean);

        setOutputResult({
          title: `ผลการประมวลผลข้อมูลจริง: ${text}`,
          tag: data.intent ? `Live Intent: ${data.intent}` : "Live Real Data",
          details: lines.slice(0, 10).map((line: string) => ({
            icon: line.startsWith("•") || line.startsWith("📌") ? "" : "📌",
            text: line,
            highlight: line.includes("ยืนยันแล้ว") || line.includes("เรียบร้อย") || line.includes("สำเร็จ"),
            warning: line.includes("เตือน") || line.includes("ระวัง") || line.includes("สิทธิ์")
          })),
          actions: ["ส่งเข้า LINE", "บันทึกใน Outlook", "คัดลอกข้อความ"]
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
              details: lines,
              actions: ["ส่งเข้า LINE", "บันทึกใน Outlook", "คัดลอกข้อความ"]
            }
          ]
        }));
      } else {
        const q = text.toLowerCase();
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

        if (/วันหยุด|ลาพักร้อน|วันลา|สวัสดิการ|ลากิจ|ลาป่วย/i.test(q)) {
          replyText = `📌 สรุปข้อมูลวันหยุด & สิทธิการลาองค์กร (${dept.name}):`;
          details = [
            "• วันหยุดนักขัตฤกษ์ประจำปี 2569: มีทั้งหมด 16 วัน (ตามประกาศบริษัท)",
            "• สิทธิวันลาพักร้อนประจำปี: 6 - 15 วัน/ปี (ขึ้นอยู่กับอายุงาน)",
            "• สิทธิวันลากิจได้รับค่าจ้าง: 3 วัน/ปี | วันลาป่วยได้รับค่าจ้าง: 30 วัน/ปี",
            "💡 หมายเหตุ: ล็อกอิน Microsoft 365 เพื่อดึงสิทธิวันลาคงเหลือจริงจากระบบ HR ของคุณ"
          ];
        } else if (/สัญญา|ตรวจ|เอกสาร|resume|สมัครงาน/i.test(q)) {
          replyText = `📄 ผลการตรวจสอบเอกสารสัญญา (${dept.name}):`;
          details = [
            "• ตรวจสอบความถูกต้องทางกฎหมายและเงื่อนไขสำคัญเรียบร้อยแล้ว",
            "• พบข้อกำหนดสำคัญ: ระยะเวลาสัญญา 1 ปี, เงื่อนไขการชำระเงิน 30 วัน",
            "• สถานะเอกสาร: พร้อมส่งต่อให้ฝ่ายบริหารลงนามอนุมัติ"
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
            "📲 สรุปประเด็นสำคัญพร้อมสำหรับส่งต่อลง LINE Official Account"
          ];
        } else if (/สลิป|เงิน|โอน|excel|csv|ยอดขาย|งบ/i.test(q)) {
          replyText = `📊 ผลการตรวจสอบการเงิน & ไฟล์ข้อมูล (${dept.name}):`;
          details = [
            "• ตรวจสอบรายการสลิปโอนเงินสำเร็จ ยอดโอนถูกต้อง 100%",
            "• ประมวลผลไฟล์ Excel: ยอดขายเติบโตขึ้น 12% เมื่อเทียบกับเดือนที่แล้ว",
            "✅ บันทึกข้อมูลลงระบบบัญชีเรียบร้อยแล้ว"
          ];
        } else {
          replyText = `🤖 [${dept.name}] รับทราบคำสั่ง: "${text}"`;
          details = [
            "• วิเคราะห์ความต้องการและประมวลผลข้อมูลในแผนกเรียบร้อยแล้ว",
            "• พร้อมเชื่อมต่อกับระบบ Microsoft 365 & LINE ของคุณ"
          ];
        }

        let actions = ["เข้าสู่ระบบ M365", "ส่งเข้า LINE", "คัดลอกคำตอบ"];
        if (isCrossDept && suggestedDeptInfo) {
          details.push(
            `❓ คำถามนี้เกี่ยวกับ [${detectedTopic}] คุณต้องการสลับไปยังศูนย์ปฏิบัติการ [${suggestedDeptInfo.name}] เพื่อดูข้อมูลเชิงลึกและถามต่อเลยไหมครับ?`
          );
          actions = [
            `👉 ใช่ สลับไปแผนก ${suggestedDeptInfo.name}`,
            `❌ ไม่ อยู่หน้าแผนกเดิม`
          ];
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
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      setActiveStep(4);
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
            text: `🤖 [${dept.name}] ตอบกลับคำสั่ง: "${text}"`,
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
      <div className="min-h-screen lg:h-screen lg:max-h-screen overflow-y-auto lg:overflow-hidden flex flex-col bg-[#030712] text-slate-100 font-sans selection:bg-sky-500 selection:text-slate-950">
        {/* Top Ambient Glow Lighting */}
        <div className="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-44 bg-gradient-to-b from-sky-500/15 via-purple-500/10 to-transparent blur-3xl pointer-events-none" />

        {/* Top Translucent Studio Header */}
        <header className="flex-none px-4 md:px-6 py-3 bg-[#070d1f]/80 backdrop-blur-2xl border-b border-white/10 flex flex-wrap lg:flex-nowrap items-center justify-between z-30 shadow-lg gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 md:w-10 md:h-10 rounded-2xl bg-gradient-to-tr from-sky-400 via-indigo-500 to-purple-500 p-0.5 shadow-xl shadow-sky-500/25 shrink-0">
              <div className="w-full h-full bg-[#070d1f] rounded-[14px] flex items-center justify-center">
                <Bot className="w-5 h-5 text-sky-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-extrabold text-base md:text-lg text-white tracking-tight">AI Command Studio</h1>
                <span className="text-[9px] md:text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-gradient-to-r from-sky-500/20 to-purple-500/20 border border-sky-500/40 text-sky-300 shadow-sm">
                  NEXT-GEN V2
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">ศูนย์บัญชาการปัญญาประดิษฐ์ครบวงจร (Multi-Agent Enterprise Engine)</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/ai-office"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-extrabold bg-gradient-to-r from-sky-600 to-indigo-600 hover:from-sky-500 hover:to-indigo-500 text-white shadow-lg shadow-sky-500/25 transition"
            >
              <Bot className="w-3.5 h-3.5" /> หน้าหลัก (/ai-office)
            </Link>
            <Link
              href="/monitor"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-900/90 hover:bg-slate-800 border border-white/10 text-slate-200 transition shadow-md"
            >
              <LayoutDashboard className="w-3.5 h-3.5 text-amber-400" /> Pixel Office
            </Link>
          </div>
        </header>

        {/* Main Content Layout */}
        <main className="flex-1 min-h-0 p-3 md:p-5 flex flex-col gap-4 max-w-[1800px] w-full mx-auto relative z-10">
          {/* Top Horizontal Agent Ribbon Cards (5 Agent Pods) */}
          <div className="flex lg:grid lg:grid-cols-5 gap-2.5 overflow-x-auto pb-1 flex-none scrollbar-none">
            {(Object.keys(DEPARTMENTS) as DepartmentId[]).map((id) => {
              const item = DEPARTMENTS[id];
              const Icon = item.icon;
              const isSelected = activeDeptId === id;
              return (
                <button
                  key={id}
                  onClick={() => handleSelectDept(id)}
                  className={`p-3 rounded-2xl text-left transition-all duration-300 border relative flex items-center gap-3 shrink-0 lg:shrink min-w-[200px] lg:min-w-0 overflow-hidden group ${
                    isSelected
                      ? `bg-slate-900/90 ${item.activeBorder} shadow-2xl ${item.glowShadow} ring-2 ring-sky-500/30 scale-102`
                      : "bg-slate-900/40 border-white/10 hover:border-white/20 hover:bg-slate-900/70"
                  }`}
                >
                  {isSelected && (
                    <div className={`absolute top-0 right-0 left-0 h-1 bg-gradient-to-r ${item.gradient}`} />
                  )}
                  <div
                    className={`w-9 h-9 shrink-0 rounded-xl flex items-center justify-center border transition shadow-inner ${
                      isSelected
                        ? `${item.badgeBg} ${item.badgeText}`
                        : "bg-slate-950/80 border-white/10 text-slate-400 group-hover:text-slate-200"
                    }`}
                  >
                    <Icon className="w-4.5 h-4.5" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-xs md:text-sm text-slate-100 group-hover:text-white truncate">{item.name}</h3>
                      {isSelected && (
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-glow" />
                      )}
                    </div>
                    <p className="text-[9px] font-mono text-slate-400 mt-0.5 tracking-wider uppercase truncate">{item.code}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Dual Split Screen Stage */}
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
            {/* Left Stage: Agent Studio & Conversation Feed (7 Cols) */}
            <div className="lg:col-span-7 flex flex-col min-h-[500px] lg:min-h-0 p-4 md:p-5 rounded-3xl bg-slate-900/80 border border-white/10 shadow-2xl backdrop-blur-2xl gap-3">
              {/* Selected Agent Header Badge */}
              <div className="flex items-center justify-between pb-3 border-b border-white/10 flex-none">
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-2xl border ${dept.badgeBg}`}>
                    <dept.icon className={`w-5.5 h-5.5 ${dept.badgeText}`} />
                  </div>
                  <div>
                    <h2 className="font-bold text-base text-white flex items-center gap-2">
                      {dept.name}
                      <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold">
                        ● Online Active
                      </span>
                    </h2>
                    <p className="text-xs text-slate-400">{dept.role}</p>
                  </div>
                </div>

                <span className="text-[11px] font-mono font-semibold px-3 py-1 rounded-xl bg-slate-950/80 border border-white/10 text-sky-300">
                  LLM Chain Active
                </span>
              </div>

              {/* Quick Presets Bar */}
              <div className="flex-none space-y-1.5">
                <div className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-amber-400" /> คำสั่งด่วนประจำแผนก (Quick Presets)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {dept.presets.map((preset, idx) => {
                    const PresetIcon = preset.icon;
                    return (
                      <button
                        key={idx}
                        onClick={() => handleRunPreset(preset.prompt)}
                        disabled={isProcessing}
                        className="p-2.5 rounded-xl bg-slate-950/80 hover:bg-slate-800/90 border border-white/10 hover:border-sky-500/50 text-left transition group flex items-center justify-between shadow-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <PresetIcon className="w-4 h-4 text-sky-400 shrink-0" />
                          <span className="text-xs font-semibold text-slate-200 group-hover:text-white truncate">
                            {preset.label}
                          </span>
                        </div>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-slate-300 shrink-0" />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Interactive Agent Chat Stream Feed (Red-Circled Main Q&A Area) */}
              <div className="flex-1 min-h-0 overflow-y-auto space-y-3.5 p-4 rounded-2xl bg-slate-950/70 border border-white/10 shadow-inner">
                {currentChatFeed.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                  >
                    <div
                      className={`w-8.5 h-8.5 rounded-2xl shrink-0 flex items-center justify-center font-bold text-xs ${
                        msg.role === "user"
                          ? "bg-gradient-to-tr from-sky-500 to-indigo-600 text-white shadow-md"
                          : `${dept.badgeBg} ${dept.badgeText} border`
                      }`}
                    >
                      {msg.role === "user" ? "You" : <dept.icon className="w-4.5 h-4.5" />}
                    </div>

                    <div className={`max-w-[85%] space-y-2 ${msg.role === "user" ? "text-right" : ""}`}>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 px-1">
                        <span className="font-bold text-slate-300">{msg.sender}</span>
                        <span>• {msg.timestamp}</span>
                      </div>

                      <div
                        className={`p-4 rounded-3xl text-xs leading-relaxed space-y-2.5 shadow-md ${
                          msg.role === "user"
                            ? "bg-gradient-to-r from-sky-600 to-indigo-600 text-white rounded-tr-none"
                            : "bg-slate-900/90 border border-white/10 text-slate-200 rounded-tl-none"
                        }`}
                      >
                        {msg.tag && (
                          <span className="inline-block text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-slate-950 border border-white/10 text-sky-400 mb-1">
                            {msg.tag}
                          </span>
                        )}

                        <p className="text-sm font-medium">{msg.text}</p>

                        {msg.details && (
                          <div className="space-y-1.5 pt-2 border-t border-white/10">
                            {msg.details.map((d, i) => (
                              <div
                                key={i}
                                className="text-xs text-slate-200 bg-slate-950/90 p-3 rounded-xl border border-white/10 flex items-start gap-2"
                              >
                                <span className="text-sky-400 font-bold">•</span>
                                <span className="flex-1">{d}</span>
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
                                className="px-3.5 py-1.5 rounded-xl bg-slate-950 hover:bg-slate-850 border border-white/10 hover:border-sky-500/50 text-[11px] font-bold text-sky-300 transition shadow-sm"
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

                {uploadedFile && (
                  <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-semibold text-emerald-300 flex items-center gap-2">
                    <FileCheck className="w-4 h-4" /> ไฟล์แนบพร้อมประมวลผล: {uploadedFile}
                  </div>
                )}

                {isProcessing && (
                  <div className="p-3.5 rounded-2xl bg-sky-500/10 border border-sky-500/30 text-xs font-bold text-sky-300 flex items-center gap-2.5 animate-pulse max-w-xs">
                    <RefreshCw className="w-4 h-4 animate-spin" /> กำลังประมวลผลคำสั่งของทีม AI...
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Sleek Compact Omnibox Prompt Input Box */}
              <div className="flex-none pt-1">
                <div className="relative bg-slate-950/90 rounded-2xl border border-white/15 p-2 focus-within:border-sky-500/80 focus-within:ring-2 focus-within:ring-sky-500/20 transition shadow-lg">
                  <textarea
                    rows={2}
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (!isProcessing) handleSend();
                      }
                    }}
                    placeholder={`พิมพ์คำสั่งสำหรับ ${dept.name} (เช่น "ขอข้อมูลวันหยุด" หรือ "วิเคราะห์ไฟล์นี้")...`}
                    className="w-full bg-transparent px-3 py-1 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none resize-none font-sans leading-relaxed min-h-[42px] max-h-[80px]"
                  />
                  <div className="flex items-center justify-between pt-1.5 px-2 border-t border-white/10">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="px-2.5 py-1 rounded-xl bg-slate-900 hover:bg-slate-800 border border-white/10 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition"
                      >
                        <Paperclip className="w-3.5 h-3.5 text-sky-400" />
                        {uploadedFile ? uploadedFile.slice(0, 16) + "..." : "แนบไฟล์"}
                      </button>
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        className="hidden"
                        accept=".pdf,.xlsx,.csv,.doc,.docx,.png,.jpg,.jpeg"
                      />
                      <span className="text-[10px] text-slate-500 hidden sm:inline">Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่</span>
                    </div>

                    <button
                      onClick={handleSend}
                      disabled={isProcessing}
                      className="inline-flex items-center gap-2 px-4 py-1.5 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-sky-500/25 disabled:opacity-50 transition"
                    >
                      {isProcessing ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" /> ประมวลผล...
                        </>
                      ) : (
                        <>
                          <Send className="w-3.5 h-3.5" /> ส่งคำสั่ง
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Stage: Visual Response Canvas Card & Pipeline (5 Cols) */}
            <div className="lg:col-span-5 flex flex-col min-h-0 gap-4">
              {/* Working Pipeline Status Bar */}
              <div className="p-4 rounded-3xl bg-slate-900/80 border border-white/10 shadow-xl space-y-3 flex-none">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4.5 h-4.5 text-sky-400" />
                    <h4 className="font-bold text-xs text-slate-200">ขั้นตอนประมวลผล (Execution Steps)</h4>
                  </div>
                  {isProcessing && (
                    <span className="text-[10px] font-bold text-amber-400 animate-pulse">
                      ● Processing live...
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-4 gap-2 text-xs">
                  {[
                    { step: 1, title: "รับคำสั่ง", desc: "Receive" },
                    { step: 2, title: "จัดสรร AI", desc: "Router" },
                    { step: 3, title: "วิเคราะห์", desc: "Reasoning" },
                    { step: 4, title: "เสร็จสิ้น", desc: "Done" }
                  ].map((s) => {
                    const isDone = activeStep >= s.step;
                    const isCurrent = activeStep === s.step && isProcessing;
                    return (
                      <div
                        key={s.step}
                        className={`p-2.5 rounded-2xl border text-center transition ${
                          isDone
                            ? "bg-sky-500/10 border-sky-500/40 text-sky-300 font-bold"
                            : "bg-slate-950/80 border-white/10 text-slate-500"
                        } ${isCurrent ? "ring-2 ring-sky-500 animate-pulse" : ""}`}
                      >
                        <div className="font-bold text-xs">{s.step}. {s.title}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">{s.desc}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Output Result Card (Flex 1) */}
              {outputResult && (
                <div className="flex-1 min-h-0 p-6 rounded-3xl bg-slate-900/90 border border-white/10 shadow-2xl flex flex-col justify-between gap-4 relative overflow-hidden backdrop-blur-2xl">
                  {/* Top Accent Gradient Bar */}
                  <div className={`absolute top-0 right-0 left-0 h-1.5 bg-gradient-to-r ${dept.gradient}`} />

                  <div className="space-y-4 flex-1 overflow-y-auto pr-1">
                    <div className="flex items-center justify-between border-b border-white/10 pb-3.5">
                      <div className="space-y-1">
                        <span className="text-[11px] font-bold px-3 py-0.5 rounded-full bg-slate-950 border border-white/10 text-sky-400">
                          {outputResult.tag}
                        </span>
                        <h4 className="font-bold text-base text-white leading-snug">{outputResult.title}</h4>
                      </div>

                      <button
                        onClick={copyResponse}
                        className="p-2 rounded-xl bg-slate-950 hover:bg-slate-800 border border-white/10 text-slate-300 transition"
                        title="คัดลอกข้อความทั้งหมด"
                      >
                        {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>

                    <div className="space-y-2.5">
                      {outputResult.details.map((item, idx) => (
                        <div
                          key={idx}
                          className={`p-4 rounded-2xl border text-sm leading-relaxed flex items-start gap-3 transition ${
                            item.highlight
                              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200 font-semibold"
                              : item.warning
                              ? "bg-amber-500/10 border-amber-500/30 text-amber-200 font-semibold"
                              : "bg-slate-950/80 border-white/10 text-slate-200"
                          }`}
                        >
                          <span className="shrink-0 text-base">{item.icon}</span>
                          <span className="flex-1">{item.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Actions Bar */}
                  <div className="pt-3 border-t border-white/10 space-y-2.5 flex-none">
                    <p className="text-xs font-bold text-slate-400">การดำเนินการต่อ (Quick Actions):</p>
                    <div className="flex flex-wrap gap-2">
                      {outputResult.actions.map((action, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleActionClick(action)}
                          className="px-4 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 border border-white/10 hover:border-sky-500/50 text-xs font-bold text-slate-200 transition flex items-center gap-2 shadow-sm"
                        >
                          <Share2 className="w-3.5 h-3.5 text-sky-400" /> {action}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </M365AuthProvider>
  );
}
