const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const { getViagens, updateRow } = require('./sheets');

// ------------------------------ LOG ------------------------------
function logInfo(msg) { console.log(`[INFO BOT B&B Transportes ${new Date().toLocaleString()}] ${msg}`); }
function logErro(msg) { console.error(`[ERRO BOT B&B Transportes ${new Date().toLocaleString()}] ${msg}`); }

// ------------------------------ CONSTANTES DE TEMPO (MS) ------------------------------
const UM_DIA = 24 * 60 * 60 * 1000;
const DOZE_HORAS = 12 * 60 * 60 * 1000;
const QUATRO_HORAS = 4 * 60 * 60 * 1000; 
const UMA_HORA = 60 * 60 * 1000;
const TRINTA_MIN = 30 * 60 * 1000;
const DEZ_MIN = 10 * 60 * 1000;

// ------------------------------ UTILITÁRIOS ------------------------------
function formatarData(data) {
    if (!data) return '';
    const partes = data.split('-');
    if (partes.length !== 3) return data;
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

function formatarTelefone(numero) {
    if (!numero) return '';
    let apenasNumeros = numero.toString().replace(/\D/g, '');
    if (apenasNumeros.startsWith('55') && (apenasNumeros.length > 11)) apenasNumeros = apenasNumeros.slice(2);
    if (apenasNumeros.length === 11) return `(${apenasNumeros.slice(0,2)})${apenasNumeros.slice(2,7)}-${apenasNumeros.slice(7)}`;
    if (apenasNumeros.length === 10) return `(${apenasNumeros.slice(0,2)})${apenasNumeros.slice(2,6)}-${apenasNumeros.slice(6)}`;
    return numero;
}

function normalizePhoneNumber(numero) {
    let apenasNumeros = (numero || '').toString().replace(/\D/g, '');
    if (apenasNumeros.startsWith('55') && apenasNumeros.length >= 12) {
        apenasNumeros = apenasNumeros.slice(2);
    }
    return apenasNumeros;
}

function obter4UltimosDigitos(numero) {
    if (!numero) return '';
    const apenasNumeros = numero.toString().replace(/\D/g, '');
    return apenasNumeros.slice(-4);
}

// ------------------------------ WHATSAPP INIT ------------------------------
const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'bot-unificado-session' }),
    puppeteer: { headless: true }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('authenticated', () => logInfo('Authenticated with WhatsApp session (Unificado).'));
client.on('auth_failure', msg => logErro('Auth failure: ' + msg));
client.on('ready', async () => {
    logInfo('WhatsApp Bot Unificado (Passageiro/Motorista) está pronto!');
    iniciarRotinas();
});

// ------------------------------ ENVIAR MENSAGEM ------------------------------
async function enviarMensagem(destinatario, mensagem, tipo) {
    const prefixo = tipo === 'motorista' ? 'Motorista' : 'Passageiro';
    if (!destinatario) { logErro(`Número inválido ao tentar enviar mensagem para ${prefixo}.`); return; }
    const id = destinatario.includes('@') ? destinatario : `${destinatario}@c.us`;
    try {
        const chat = await client.getChatById(id);
        await chat.sendMessage(mensagem);
        logInfo(`Mensagem enviada para ${prefixo} ${id}: "${mensagem.replace(/\n/g, ' | ')}"`);
    } catch (err) {
        logErro(`Erro ao enviar para ${prefixo} ${id}: ${err.message}`);
    }
}

// ------------------------------ ROTINA CRON UNIFICADA ------------------------------
function iniciarRotinas() {
    cron.schedule('*/30 * * * * *', async () => {
        try {
            let rows = await getViagens();
            
            const activeRows = rows.filter(r => 
                (r.StatusAvaliacao !== 'respondido' && r.FluxoPassageiro !== 'finalizado') ||
                (r.TelefoneMotorista && r.FluxoMotorista !== 'avaliacao_respondida' && r.FluxoMotorista !== 'indisponivel' && r.FluxoMotorista !== 'info_viagem_concluida')
            );

            const agora = new Date();
            logInfo(`Verificando ${activeRows.length} viagens ativas...`);

            for (const row of activeRows) {
                if (!row.Data || !row.Hora) continue;
                
                const viagemData = new Date(`${row.Data} ${row.Hora}`);
                if (isNaN(viagemData.getTime())) continue;

                const diff = viagemData - agora;
                const diffPos = agora - viagemData;

                // FLUXO PASSAGEIRO
                const numeroPassageiro = row.LID || row.Telefone;
                const statusConfirmado = String(row.StatusPassageiroConfirmado).toLowerCase();

                if (statusConfirmado !== 'nao' &&
                    (!row.StatusPassageiroConfirmado || row.StatusPassageiroConfirmado === 'false') &&
                    (!row.FluxoPassageiro || row.FluxoPassageiro === '') &&
                    diff <= UM_DIA && diff > 0) { 

                    const ultimos4Passageiro = obter4UltimosDigitos(row.Telefone);

                    await enviarMensagem(row.Telefone,
                        `Olá, ${row.Nome}! Sua viagem foi confirmada:\n📅 Data: ${formatarData(row.Data)}\n⏰ Horário: ${row.Hora}\n📍 Origem: ${row.Origem}\n🏁 Destino: ${row.Destino}`, 'passageiro');
                    await enviarMensagem(row.Telefone,
                        `🔎 *Confirme os 4 últimos dígitos do seu telefone:*\nOs últimos 4 dígitos são: ${ultimos4Passageiro}`, 'passageiro');

                    row.FluxoPassageiro = 'reconhecimento';
                    await updateRow(row);
                    logInfo(`Aguardando confirmação de 4 dígitos da viagem para Passageiro ${row.Nome}`);
                }

                let nivelLembrete = parseInt(row.StatusLembrete) || 0;

                if (statusConfirmado !== 'nao' && row.LID && diff > 0) {
                    let msgLembrete = '';
                    let novoNivel = 0;
                    
                    if (nivelLembrete < 1 && diff <= UMA_HORA && diff > TRINTA_MIN) {
                        msgLembrete = `⏰ *Lembrete de viagem*\n\nOlá ${row.Nome}, sua viagem está agendada para daqui a 1 hora: ${formatarData(row.Data)} às ${row.Hora}\n\n🚖 Motorista: ${row.Motorista} - ${formatarTelefone(row.TelefoneMotorista)}\n📍 Origem: ${row.Origem}\n🏁 Destino: ${row.Destino}\n👥 Passageiros: ${row.Passageiros || '?'}\n🧳 Malas: ${row.Malas || '?'}`;
                        novoNivel = 1;
                    }
                    else if (nivelLembrete < 2 && diff <= TRINTA_MIN && diff > DEZ_MIN) {
                        msgLembrete = `⏰ *Lembrete de viagem*\n\nOlá ${row.Nome}, sua viagem está agendada para daqui a 30 minutos: ${formatarData(row.Data)} às ${row.Hora}\n\n🚖 Motorista: ${row.Motorista} - ${formatarTelefone(row.TelefoneMotorista)}\n📍 Origem: ${row.Origem}\n🏁 Destino: ${row.Destino}\n👥 Passageiros: ${row.Passageiros || '?'}\n🧳 Malas: ${row.Malas || '?'}`;
                        novoNivel = 2;
                    }
                    else if (nivelLembrete < 3 && diff <= DEZ_MIN) {
                        msgLembrete = `⏰ *Lembrete de viagem*\n\nOlá ${row.Nome}, sua viagem está agendada para daqui a 10 minutos: ${formatarData(row.Data)} às ${row.Hora}\n\n🚖 Motorista: ${row.Motorista} - ${formatarTelefone(row.TelefoneMotorista)}\n📍 Origem: ${row.Origem}\n🏁 Destino: ${row.Destino}\n👥 Passageiros: ${row.Passageiros || '?'}\n🧳 Malas: ${row.Malas || '?'}`;
                        novoNivel = 3;
                    }

                    if (msgLembrete && novoNivel > 0 && numeroPassageiro) { 
                        await enviarMensagem(numeroPassageiro, msgLembrete, 'passageiro');
                        row.StatusLembrete = String(novoNivel); 
                        await updateRow(row);
                        logInfo(`Lembrete nível ${novoNivel} enviado para Passageiro ${row.Nome}`);
                    }
                }

                if ((!row.StatusAvaliacao || row.StatusAvaliacao === '') && row.LID &&
                    diffPos >= UM_DIA) { 

                    row.FluxoPassageiro = 'avaliacao';
                    row.StatusAvaliacao = 'enviado'; 
                    await updateRow(row);

                    await enviarMensagem(numeroPassageiro,
                        `⭐ Olá, ${row.Nome}.\n\nEsperamos que sua viagem com ${row.Motorista} ontem tenha ocorrido bem.\nFique à vontade para incluir sugestões para melhoria ou se houve qualquer incômodo.\nPor favor, avalie:\n1️⃣ Ótima\n2️⃣ Boa\n3️⃣ Tive problemas na viagem`, 'passageiro');
                    logInfo(`Solicitação de avaliação enviada para Passageiro ${row.Nome}`);
                }

                // FLUXO MOTORISTA
                if (row.TelefoneMotorista) {
                    const statusMotorista = row.FluxoMotorista || '';
                    const destinatarioMotorista = row.LIDMotorista || row.TelefoneMotorista;

                    if ((!statusMotorista || statusMotorista === '') &&
                        diff <= UM_DIA && diff > 0) { 
                        
                        const ultimos4Motorista = obter4UltimosDigitos(row.TelefoneMotorista);

                        await enviarMensagem(row.TelefoneMotorista,
                            `Nova viagem atribuída\n\nOlá, ${row.Motorista}!\nVocê foi designado para uma nova corrida:\n\n📅 Data: ${formatarData(row.Data)}\n⏰ Horário: ${row.Hora}\n📍 Origem: ${row.Origem}\n🏁 Destino: ${row.Destino}`, 'motorista');
                        
                        await enviarMensagem(row.TelefoneMotorista,
                            `✅ Para confirmar, responda com os 4 últimos dígitos do seu telefone:\nOs últimos 4 dígitos são: ${ultimos4Motorista}`, 'motorista');

                        row.FluxoMotorista = 'aguardando_aceite_24h';
                        await updateRow(row);
                        logInfo(`Solicitação de confirmação de 4 dígitos de 24h enviada para Motorista ${row.Motorista}`);
                    }

                    else if (statusMotorista === 'aceito' &&
                                    diff <= DOZE_HORAS && diff > UMA_HORA) {
                        
                        await enviarMensagem(destinatarioMotorista,
                            `⏰ Lembrete de viagem\n\nOlá ${row.Motorista}, sua corrida com o cliente ${row.Nome}, está agendada às ${row.Hora} de ${formatarData(row.Data)}.\n\nPrepare-se e esteja no local combinado com pelo menos 10 minutos de antecedência.\nBoa rota e bom trabalho!`);
                        
                        row.FluxoMotorista = 'lembrete_12h';
                        await updateRow(row);
                        logInfo(`Lembrete de 12h enviado para Motorista ${row.Motorista}`);
                    }
                    
                    else if (['aceito', 'lembrete_12h'].includes(statusMotorista) &&
                                    diff <= UMA_HORA && diff > 0) {
                        
                        await enviarMensagem(destinatarioMotorista,
                            `⏰ Lembrete de viagem\n\nOlá, ${row.Motorista}, sua corrida com o cliente ${row.Nome}, está agendada às ${row.Hora} de ${formatarData(row.Data)}. Falta *1 hora* para a viagem.\n\nPrepare-se e esteja no local combinado com pelo menos 10 minutos de antecedência.\n\nLembre-se de compartilhar a localização conosco antes de iniciar a viagem.\n\nBoa rota e bom trabalho!`);
                        
                        row.FluxoMotorista = 'lembrete_1h';
                        await updateRow(row);
                        logInfo(`Lembrete de 1h enviado para Motorista ${row.Motorista}`);
                    }

                    else if (['lembrete_1h', 'aceito', 'lembrete_12h'].includes(statusMotorista) &&
                                    diffPos >= QUATRO_HORAS && diffPos < UM_DIA && !row.KmPercorrida) {

                        await enviarMensagem(destinatarioMotorista,
                            `📋Olá, ${row.Motorista}.\n\nPrecisamos coletar algumas informações da viagem no dia ${formatarData(row.Data)} às ${row.Hora}.\n\nPor favor, informe a *quilometragem percorrida* (apenas números, ex: 25):`, 'motorista');
                        
                        row.FluxoMotorista = 'solicitar_km';
                        await updateRow(row);
                        logInfo(`Solicitação de Km percorrida enviada para Motorista ${row.Motorista}`);
                    }
                    
                    else if (row.KmPercorrida && ['lembrete_1h', 'aceito', 'lembrete_12h', 'info_viagem_concluida'].includes(statusMotorista) &&
                                    diffPos >= UM_DIA && statusMotorista !== 'avaliacao_enviada') { 
                        
                        await enviarMensagem(destinatarioMotorista,
                            `Olá, ${row.Motorista}.\n\nA viagem do dia ${formatarData(row.Data)} às ${row.Hora} foi concluída.\nSua resposta é importante para que possamos melhorar a qualidade do serviço e entender qualquer transtorno.\n\nAvalie como foi a corrida:\n1️⃣ Sem problemas\n2️⃣ Ocorreram imprevistos leves\n3️⃣ Ocorreram problemas relevantes`, 'motorista');
                        
                        row.FluxoMotorista = 'avaliacao_enviada';
                        await updateRow(row);
                        logInfo(`Solicitação de avaliação pós-viagem enviada para Motorista ${row.Motorista}`);
                    }
                }
            }
        } catch (err) {
            logErro(`Erro na rotina principal do bot unificado: ${err.message}`);
        }
    });
}

// ------------------------------ RECEBIMENTO DE MENSAGENS UNIFICADO ------------------------------
client.on('message', async msg => {
    try {
        const texto = msg.body.trim().toLowerCase();
        const senderId = msg.from;
        const senderPhone = senderId.split('@')[0];
        const normalizedSenderPhone = normalizePhoneNumber(senderPhone);

        logInfo(`Mensagem recebida de ${senderId}: "${texto}"`);

        const rows = await getViagens();
        
        let viagem = null;
        let tipoViagem = null;

        // 1. Tenta casar como FLUXO ATIVO POR LID (Passageiro)
        viagem = rows.find(r => 
            (r.LID || '') === senderId && 
            r.FluxoPassageiro && ['reconhecimento', 'passageiros', 'malas', 'avaliacao'].includes(r.FluxoPassageiro)
        );
        if (viagem) {
            tipoViagem = 'passageiro';
            logInfo(`[DETECTADO PASSAGEIRO] Viagem de ${viagem.Nome} encontrada pelo LID: ${senderId}. Fluxo: ${viagem.FluxoPassageiro}`);
        }
        
        // 2. Tenta casar com FLUXO ATIVO POR LIDMotorista (Motorista)
        if (!viagem) {
            viagem = rows.find(r => 
                (r.LIDMotorista || '') === senderId &&
                r.FluxoMotorista && ['aguardando_aceite_24h', 'avaliacao_enviada', 'solicitar_km', 'solicitar_valor', 'solicitar_tempo', 'solicitar_justificativa'].includes(r.FluxoMotorista) 
            );
            if (viagem) {
                tipoViagem = 'motorista';
                viagem.LIDMotorista = senderId;
                logInfo(`[DETECTADO MOTORISTA] Viagem de ${viagem.Nome} encontrada pelo LIDMotorista. Status: ${viagem.FluxoMotorista}.`);
            }
        }

        // 3. Tenta casar com FLUXO ATIVO POR TELEFONE (Motorista, primeira interação)
        if (!viagem && !senderId.includes('@lid')) { 
            viagem = rows.find(r => 
                !r.LIDMotorista && 
                r.TelefoneMotorista && normalizePhoneNumber(r.TelefoneMotorista) === normalizedSenderPhone &&
                r.FluxoMotorista === 'aguardando_aceite_24h'
            );
            if (viagem) {
                tipoViagem = 'motorista';
                viagem.LIDMotorista = senderId;
                logInfo(`[DETECTADO MOTORISTA - 1ª INTERAÇÃO] Viagem de ${viagem.Nome} encontrada pelo Telefone. LIDMotorista registrado: ${senderId}.`);
            }
        }
        
        // 4. Tenta casar com RECONHECIMENTO PENDENTE (Passageiro, 1ª interação)
        if (!viagem && !senderId.includes('@lid')) { 
            const pendentesReconhecimento = rows.filter(r => 
                r.FluxoPassageiro === 'reconhecimento' && 
                (!r.LID || r.LID === '') &&
                normalizePhoneNumber(r.Telefone) === normalizedSenderPhone
            );

            if (pendentesReconhecimento.length === 1) {
                viagem = pendentesReconhecimento[0];
                tipoViagem = 'passageiro';
                viagem.LID = senderId;
                logInfo(`[DETECTADO RECONHECIMENTO PENDENTE] Viagem de ${viagem.Nome}. LID registrado: ${senderId}.`);
            }
        }

        // 5. Validação para ambiente de teste (@lid) - Procura TODAS as viagens pendentes
        if (!viagem && senderId.includes('@lid')) {
            // Busca TODAS as viagens de motoristas pendentes
            const motoristasPendentes = rows.filter(r => 
                r.FluxoMotorista === 'aguardando_aceite_24h' && (!r.LIDMotorista || r.LIDMotorista === '')
            );
            
            // Busca TODAS as viagens de passageiros pendentes
            const passageirosPendentes = rows.filter(r => 
                r.FluxoPassageiro === 'reconhecimento' && (!r.LID || r.LID === '')
            );
            
            // Procura motorista com 4 dígitos corretos
            let motoristaCorristo = motoristasPendentes.find(r => 
                texto === obter4UltimosDigitos(r.TelefoneMotorista)
            );
            
            // Procura passageiro com 4 dígitos correto
            let passageiroCorristo = passageirosPendentes.find(r => 
                texto === obter4UltimosDigitos(r.Telefone)
            );
            
            // Se encontrou motorista com 4 dígitos corretos
            if (motoristaCorristo) {
                viagem = motoristaCorristo;
                tipoViagem = 'motorista';
                viagem.LIDMotorista = senderId;
                logInfo(`[FALLBACK @lid MOTORISTA] Viagem de ${viagem.Motorista} encontrada com 4 dígitos ${texto} válidos.`);
            }
            // Se encontrou passageiro com 4 dígitos corretos
            else if (passageiroCorristo) {
                viagem = passageiroCorristo;
                tipoViagem = 'passageiro';
                viagem.LID = senderId;
                logInfo(`[FALLBACK @lid PASSAGEIRO] Viagem de ${viagem.Nome} encontrada com 4 dígitos ${texto} válidos.`);
            }
        }
        
        if (!viagem) {
            logInfo(`Nenhuma viagem ativa encontrada para ${senderId}. Ignorando.`);
            return; 
        }

        viagem.DataUltimaInteracao = new Date().toISOString();

        // ======================================================================
        // PROCESSAMENTO DO FLUXO
        // ======================================================================
        
        if (tipoViagem === 'passageiro') {
            if (viagem.FluxoPassageiro === 'reconhecimento') {
                const ultimos4Esperados = obter4UltimosDigitos(viagem.Telefone);
                
                if (texto === ultimos4Esperados) {
                    viagem.FluxoPassageiro = 'passageiros';
                    viagem.StatusPassageiroConfirmado = 'true';
                    viagem.LID = senderId;
                    await updateRow(viagem);
                    await enviarMensagem(senderId, 
                        `✅ Confirmação realizada com sucesso!\n\nAgora precisamos confirmar algumas informações.\nQuantas pessoas irão viajar?\n1️⃣ 1 pessoa\n2️⃣ 2 pessoas\n3️⃣ 3 pessoas\n4️⃣ 4 pessoas ou mais`, 'passageiro');
                } else {
                    await enviarMensagem(senderId, `⚠️ Código inválido. Por favor, confirme os 4 últimos dígitos do seu telefone.`, 'passageiro');
                }
                return;
            }
            if (viagem.FluxoPassageiro === 'passageiros') {
                const opPassageiros = {
                    "1": "1 pessoa", "2": "2 pessoas", "3": "3 pessoas", "4": "4 pessoas ou mais"
                };
                if (opPassageiros[texto]) {
                    viagem.Passageiros = opPassageiros[texto];
                    viagem.FluxoPassageiro = "malas";
                    await updateRow(viagem);
                    await enviarMensagem(
                        senderId, 
                        `Agora informe a quantidade de malas:\n1️⃣ 1 mala\n2️⃣ 2 malas\n3️⃣ 3 malas\n4️⃣ 4 malas ou mais\n5️⃣ Não vou levar malas`, 'passageiro'
                    );
                } else {
                    await enviarMensagem(senderId, `⚠️ Responda apenas uma das opções disponíveis.`, 'passageiro'); 
                }
                return;
            }

            if (viagem.FluxoPassageiro === 'malas') {
                const opMalas = {
                    "1": "1 a 2 malas", "2": "2 a 3 malas", "3": "3 a 4 malas", "4": "4 malas ou mais", "5": "Não vou levar malas"
                };
                if (opMalas[texto]) {
                    viagem.Malas = opMalas[texto];
                    viagem.FluxoPassageiro = "viagem"; 
                    await updateRow(viagem);
                    await enviarMensagem(senderId, `✅ Obrigado por confirmar seus dados.`, 'passageiro'); 
                } else {
                    await enviarMensagem(senderId, `⚠️ Responda apenas uma das opções disponíveis.`, 'passageiro'); 
                }
                return;
            }
            
            if (viagem.FluxoPassageiro === 'avaliacao') {
                if (["1", "2", "3"].includes(texto)) {
                    viagem.Avaliacao = texto;
                    viagem.FluxoPassageiro = "finalizado";
                    viagem.StatusAvaliacao = "respondido"; 
                    await updateRow(viagem);

                    const mensagemAvaliacao = {
                        "1": `⭐ Agradecemos pela confiança, ${viagem.Nome}! Ficamos felizes em saber que sua experiência foi positiva.`,
                        "2": `🙂 Obrigado pelo feedback, ${viagem.Nome}. Vamos melhorar onde for necessário.`,
                        "3": `⚠️ Lamentamos que tenha tido problemas, ${viagem.Nome}. Sua opinião será registrada e vamos trabalhar para melhorar.`
                    };
                    await enviarMensagem(senderId, mensagemAvaliacao[texto], 'passageiro');
                } else {
                    await enviarMensagem(senderId, `⚠️ Responda apenas uma das opções disponíveis.`, 'passageiro'); 
                }
                return;
            }
        } 
        
        else if (tipoViagem === 'motorista') {
            // ACEITE DA VIAGEM (24h com 4 dígitos)
            if (viagem.FluxoMotorista === 'aguardando_aceite_24h') {
                const ultimos4Esperados = obter4UltimosDigitos(viagem.TelefoneMotorista);
                
                if (texto === ultimos4Esperados) {
                    // Verifica se já foi aceita
                    if (viagem.FluxoMotorista === 'aceito') {
                        await enviarMensagem(senderId, `⚠️ Desculpe, esta viagem já foi confirmada por outro motorista.`, 'motorista');
                        logInfo(`Tentativa de confirmação duplicada detectada.`);
                        return;
                    }
                    
                    viagem.FluxoMotorista = 'aceito';
                    viagem.LIDMotorista = senderId;
                    await updateRow(viagem); 
                    await enviarMensagem(senderId, 
                        `✅ Confirmação recebida! Obrigado, ${viagem.Motorista}!\nSua viagem foi confirmada:\n\n📅 Data: ${formatarData(viagem.Data)}\n⏰ Horário: ${viagem.Hora}\n📍 Origem: ${viagem.Origem}\n🏁 Destino: ${viagem.Destino}\n\n*Lembre-se de chegar com pelo menos 10 minutos de antecedência.*`, 'motorista');
                    logInfo(`Viagem confirmada para Motorista com LID: ${senderId}`);
                    return;
                } else {
                    await enviarMensagem(senderId, `⚠️ Código inválido. Por favor, confirme os 4 últimos dígitos do seu telefone.`, 'motorista');
                    return;
                }
            }
            
            // Solicitar KM
            if (viagem.FluxoMotorista === 'solicitar_km') {
                const km = parseFloat(texto.replace(',', '.'));
                if (!isNaN(km) && km >= 0) {
                    viagem.KmPercorrida = km.toFixed(2);
                    viagem.FluxoMotorista = 'solicitar_valor';
                    await updateRow(viagem);
                    await enviarMensagem(senderId, `✅ Quilometragem registrada! Agora informe o valor final da corrida (apenas números, ex: 50):`, 'motorista');
                    logInfo(`Quilometragem ${km} registrada para ${viagem.Motorista}`);
                } else {
                    await enviarMensagem(senderId, `⚠️ Entrada inválida. Por favor, informe a quilometragem (Ex: 25)`, 'motorista');
                }
                return;
            }

            // Solicitar Valor
            if (viagem.FluxoMotorista === 'solicitar_valor') {
                const valor = parseFloat(texto.replace(',', '.'));
                if (!isNaN(valor) && valor >= 0) {
                    viagem.ValorFinal = valor.toFixed(2);
                    viagem.FluxoMotorista = 'solicitar_tempo';
                    await updateRow(viagem);
                    await enviarMensagem(senderId, `✅ Valor registrado! E qual foi o *tempo de duração* total da viagem (em minutos, ex: 45):`, 'motorista');
                    logInfo(`Valor final R$ ${valor} registrado para ${viagem.Motorista}`);
                } else {
                    await enviarMensagem(senderId, `⚠️ Entrada inválida. Por favor, informe o valor (Ex: 50)`, 'motorista');
                }
                return;
            }

            // Solicitar Tempo
            if (viagem.FluxoMotorista === 'solicitar_tempo') {
                const tempo = parseInt(texto.replace(/\D/g, ''));
                if (!isNaN(tempo) && tempo >= 0) {
                    viagem.TempoDuracao = tempo;
                    viagem.FluxoMotorista = 'solicitar_justificativa';
                    await updateRow(viagem);
                    await enviarMensagem(senderId, `✅ Duração registrada! Por fim, adicione uma *justificativa* ou observação (ou responda "ok" se não há):`, 'motorista');
                    logInfo(`Tempo de duração ${tempo}min registrado para ${viagem.Motorista}`);
                } else {
                    await enviarMensagem(senderId, `⚠️ Entrada inválida. Por favor, informe o tempo em *minutos* (Ex: 45)`, 'motorista');
                }
                return;
            }

            // Solicitar Justificativa
            if (viagem.FluxoMotorista === 'solicitar_justificativa') {
                viagem.Justificativa = msg.body.trim();
                viagem.FluxoMotorista = 'info_viagem_concluida';
                await updateRow(viagem);
                await enviarMensagem(senderId, `✅ Dados da viagem registrados com sucesso, Obrigado, ${viagem.Motorista}!`, 'motorista');
                logInfo(`Justificativa registrada para ${viagem.Motorista}: "${viagem.Justificativa}"`);
                return;
            }

            // AVALIAÇÃO PÓS-VIAGEM
            if (viagem.FluxoMotorista === 'avaliacao_enviada') {
                if (["1", "2", "3"].includes(texto)) {
                    viagem.AvaliacaoMotorista = texto;
                    viagem.FluxoMotorista = 'avaliacao_respondida'; 
                    await updateRow(viagem); 
                    
                    const mensagemAvaliacao = {
                        "1": `🌟 Agradecemos pelo retorno, ${viagem.Motorista}. Ficamos felizes em saber que ocorreu tudo bem durante a viagem.`,
                        "2": `🙂 Obrigado por compartilhar conosco, ${viagem.Motorista}. Sua observação foi registrada e será analisada para possíveis melhorias.`,
                        "3": `⚠️ Obrigado por compartilhar conosco, ${viagem.Motorista}. Sua observação foi registrada para que possamos melhorar a qualidade do serviço.`
                    };
                    await enviarMensagem(senderId, mensagemAvaliacao[texto], 'motorista');
                    logInfo(`Avaliação ${texto} registrada para ${viagem.Motorista}`);
                    return;
                } else {
                    await enviarMensagem(senderId, `⚠️ Responda apenas uma das opções disponíveis.`, 'motorista');
                    return;
                }
            }
        }
    } catch (err) {
        logErro(`Erro ao processar mensagem: ${err.message}`);
    }
});

// ------------------------------ INICIALIZA ------------------------------
client.initialize();