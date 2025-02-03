import { SimulationService } from './services/simulation.service';

async function runSimulation() {
    try {
        const simulationService = new SimulationService();
        
        console.log('\n🔄 Menjalankan Single Trade Simulation...');
        const singleTrade = await simulationService.simulateTradeWithRealData('0.1'); // 0.1 ETH
        console.log('\n📊 Hasil Single Trade:');
        console.log('=======================');
        if (singleTrade.success && 'amountIn' in singleTrade) {
            console.log(`Token In: WETH`);
            console.log(`Token Out: USDC`);
            console.log(`Amount In: ${singleTrade.amountIn} wei`);
            console.log(`Estimated Out: ${singleTrade.estimatedAmountOut} USDC`);
            console.log(`Gas Estimate: ${singleTrade.estimatedGas}`);
        } else {
            console.log(`Status: ❌ Failed`);
            console.log(`Error: ${(singleTrade as { error: string }).error}`);
        }
        
        console.log('\n🔄 Menjalankan Multiple Trades Simulation...');
        const multipleTrades = await simulationService.simulateMultipleTrades();
        console.log('\n📊 Hasil Multiple Trades:');
        console.log('=========================');
        multipleTrades.forEach((trade, index) => {
            console.log(`\nTrade #${index + 1}:`);
            console.log(`Description: ${trade.description}`);
            console.log(`Amount: ${trade.amountIn} ETH`);
            if ('result' in trade && trade.result?.success && 'estimatedAmountOut' in trade.result) {
                console.log(`Status: ✅ Success`);
                console.log(`Estimated Out: ${trade.result.estimatedAmountOut} USDC`);
            } else if ('error' in trade) {
                console.log(`Status: ❌ Failed`);
                console.log(`Error: ${trade.error}`);
            }
        });

    } catch (error) {
        console.error('❌ Error dalam simulasi:', error);
    }
}

// Jalankan simulasi
runSimulation().catch(console.error); 