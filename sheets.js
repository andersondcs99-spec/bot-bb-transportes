// sheets.js
const { GoogleSpreadsheet } = require('google-spreadsheet');
const creds = require('./credentials.json');

const SPREADSHEET_ID = '18lAURw_o5wvMIFUlay1cOW50JJ3NjseeEthwtLgKGkU';

// Carrega a aba "viagens"
async function carregarPlanilha() {
    try {
        const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
        await doc.useServiceAccountAuth(creds);
        await doc.loadInfo();

        const sheet = doc.sheetsByTitle['viagens'];
        if (!sheet) throw new Error('Aba "viagens" não encontrada!');
        return sheet;

    } catch (err) {
        console.error("Erro ao carregar planilha:", err);
        throw err;
    }
}

// Retorna todas as viagens como rows com .save()
async function getViagens() {
    try {
        const sheet = await carregarPlanilha();
        const rows = await sheet.getRows();
        return rows;
    } catch (err) {
        console.error("Erro ao obter viagens:", err);
        return [];
    }
}

// Atualiza uma linha da planilha
async function updateRow(row) {
    try {
        await row.save();
        console.log(`[INFO] Linha atualizada: Nome=${row.Nome}, FluxoAtual=${row.FluxoAtual}, Passageiros=${row.Passageiros}, Malas=${row.Malas}`);
    } catch (err) {
        console.error(`[ERRO] Não foi possível atualizar linha: ${err.message}`);
    }
}

// Adiciona uma nova viagem na planilha
async function addRowViagem(dados) {
    try {
        const sheet = await carregarPlanilha();
        await sheet.addRow(dados);
        console.log(`[INFO] Nova viagem adicionada: ${JSON.stringify(dados)}`);
    } catch (err) {
        console.error("Erro ao adicionar viagem:", err);
    }
}

module.exports = {
    carregarPlanilha,
    getViagens,
    updateRow,
    addRowViagem
};
