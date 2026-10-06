// 노드 기획 놀이터에서 만든 기획 결과를 AIServiceHub 경유로 클래스로그AI에 제출하는 프록시.
// CLASS_TOOL_API_KEY는 이 함수(서버) 안에서만 사용되며 클라이언트에는 절대 내려가지 않는다.

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function handler(request) {
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
    }

    const baseUrl = process.env.AISERVICEHUB_BASE_URL;
    const apiKey = process.env.CLASS_TOOL_API_KEY;
    if (!baseUrl || !apiKey) {
        return new Response(
            JSON.stringify({ error: '서버 설정이 필요해요' }),
            { status: 500 }
        );
    }

    // 같은 사이트에서 보낸 요청인지 확인 (보조 수단)
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const raw = body && typeof body === 'object' ? body : {};
    // 허용한 필드만 골라서 길이 제한
    const clean = {
        entryCode: str(raw.entryCode, 100),
        studentId: str(raw.studentId, 100) || undefined,
        studentName: str(raw.studentName, 100) || undefined,
        title: str(raw.title, 200),
        resultType: raw.resultType,
        linkUrl: str(raw.linkUrl, 2000) || undefined,
        textContent: str(raw.textContent, 20000) || undefined,
    };
    const { entryCode, title, resultType, linkUrl } = clean;
    if (!entryCode || !title || !resultType) {
        return new Response(JSON.stringify({ error: 'entryCode, title, resultType은 필수입니다' }), { status: 400 });
    }
    if (resultType !== 'link' && resultType !== 'text') {
        return new Response(JSON.stringify({ error: 'resultType은 link 또는 text여야 합니다' }), { status: 400 });
    }
    if (linkUrl && !/^https:\/\//i.test(linkUrl)) {
        return new Response(JSON.stringify({ error: '링크는 https:// 로 시작해야 해요' }), { status: 400 });
    }

    try {
        const upstream = await fetch(`${baseUrl}/api/classlog/submission`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
            },
            body: JSON.stringify(clean),
        });
        const data = await upstream.json().catch(() => null);
        return new Response(JSON.stringify(data), { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
        console.error('submit proxy failed', err); // 자세한 내용은 서버 로그에만
        return new Response(JSON.stringify({ error: '제출 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.' }), { status: 502 });
    }
}

export default { fetch: handler };
